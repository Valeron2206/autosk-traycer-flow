# Cloud session priming: from `main` to final panel #39

Written 2026-09-26 when the owner paused local orchestration and moved the remaining work to a cloud session.

The owner's standing instructions:
- Carry the remaining items one at a time, and close every debt.
- Stop once final panel #39 attests `pass` (milestone Design-ready).

Read this file first. Then read `CONTRIBUTING.md`, `docs/contracts/`, and the validators named below. Where this file and the repository disagree, the repository wins: record the disagreement and ask the owner.

## 1. State of `main` on 2026-09-26

| what | value |
| --- | --- |
| `main` | `dd29a03` (PR #244, debt 7k), CI green |
| `npm test` on CI | 2475 tests: 2474 pass, 1 skipped |
| validators | all 46 `npm run validate:*` pass |
| mutation job (workflow_dispatch and push to `main`) | `modules=51 mutants=1778 killed=1762 survivors=16 named=16 killed_by_timeout=4 environment_failures=0 report_digest=701cee44cdf85b3a2d9bdb279467f656219281682635212286aebf83a0a937a6` |
| autosk compatibility series | `compat/autosk/manifest.v1.json`: 48 patches, `0050` last, `result_tree` `3f3051a76a9a94858c910411df645d7d7ee2cb40`; upstream `wierdbytes/autosk` at `5163f00dd25005480dc7f3e40a0c40d18248857a` |
| runtime identity lock | `requirements=25`, `lock_digest=3e8a5b437cad4b442ad3c7712ccff665f6390dbed87e839575c343b20953a270`, `counted_across=48` |
| design candidate | `resources/design-candidate/design-candidate.v1.json`, `candidate_digest` `47de4b9a2d989f137792f763faefa4f357a34169522811ed59edc3072543d663`, attestation `pending_final_panel` |

Recently closed debts: 7i (#241), 7h (#242), 7j (#243) and 7k (#244). All were merged with CI green, and the mutation baseline did not change. Earlier debts 1 to 7g were closed in #218 to #240.

## 2. What remains, in this order

### 2.1 Debt 7l: an extension error that no message can be made of crashes the daemon

**Status.** Started on `dd29a03`. Nothing is committed or pushed. The local measurement was stopped before it produced evidence, so start from the current `main` and measure first.

**Defect.** Found by debt 7k's full review (R7k-7, Medium); it predates patch `0050`.
- Extension code can throw a value that no message can be made of: `Object.create(null)`, a Proxy whose `getPrototypeOf` trap throws, or an Error whose `message` getter throws.
- In the prepared series:
  - `daemon/core/src/rpc/errors.ts:56`, `toRpcError`, formats a rejection with `e instanceof Error ? e.message : String(e)`. A handler rejected with such a value throws inside `processLine`, and autoskd crashes. This was reproduced on the base and on the 7k candidate: an `onTransit` function that throws `Object.create(null)` at `task.enroll` gives `TypeError: No default value at toRpcError … at processLine`, and the daemon is gone.
  - `daemon/core/src/extensions/loader.ts:297` has its own `errMsg` with the same expression. It is used for `failed to import` (`:428`) and `factory threw` (`:447`). A factory that throws such a value itself makes the loader's catch throw, and the project fails to open.
  - `daemon/core/src/extensions/servedDistributions.ts:64` carries a third copy.
- Patch `0050` already made `errMsg` in `daemon/core/src/engine/types.ts` and in `registry.ts` total, with the placeholder `an unprintable value`.

**Carried from debt 7k's narrow re-review (Low).** Fix these in the same patch `0051`:
- **R7k-8.** `0050`'s total `errMsg` maps a printable non-string message to the placeholder in every engine catch, `finalizeFailed` included; examples are an Error whose `message` is `404`, `undefined`, `null` or `{a:1}`. Keep `String(m)` inside the try, and use the placeholder only when the conversion throws.
- **R7k-9.** `registry.ts` `admitWorkflow` indents its whole body six spaces to keep this lock-anchored line at six spaces: `      if (workflow.graphDigest !== undefined) admission.document = workflow.graphDigest;`. Move the `if (identity) { … }` block into the method, so the body takes its natural indent and the anchored line stays byte-identical.
- **R7k-10**, wording:
  - (a) the `addWorkflow` and `addAgent` doc comments say any read that throws before the store skips the registration, while an optional hook whose read throws is skipped alone;
  - (b) `docs/extensions.md` calls the skipping reads "required fields and the shape", but a throwing `description` getter skips the registration too;
  - (c) a test comment in `extensions.registry.test.ts`, on the `graphDigest` case, counts three reads where there are four;
  - (d) a test comment claims the `addAgent` rollback is exercised, but it is not observable there;
  - (e) a comment says "Two outcomes are new here", which is history, not behavior;
  - (f) the docs say an unpinned task "parks at resume": a parked unpinned task is refused at resume (1004), and a working one parks at the next dispatch.

**Acceptance.**
- No value thrown by extension code crashes the daemon or fails a project open because it cannot be formatted, shown by a test and a live run.
- The operator sees an honest error.
- The RPC error format is unchanged for every value that formats today.
- R7k-8, R7k-9 and R7k-10 are closed.
- `npm test`, the validators and the series' suites are green, and the review follows §3.

**Work type:** bug-fix (§6).

### 2.2 Item 8: close slice s6-migration

The slice's five acceptance criteria:
1. an unsupported pair fails closed, with no partial writes;
2. a crash at every migration phase is recoverable, and every phase has a test;
3. an active Epic continues on the graph it was admitted under, or stops until an explicit migration; no partial execution under two graphs;
4. rollback does not substitute the identity;
5. a mutation run is mandatory when host modules change.

The measurement of 2026-09-21, on 38 patches:
- 1 and 2 were carried (`0007-migration-planning.patch:468`, `0008-migration-apply.patch:493`);
- 3 was carried per task (`document_digest_in_shape`, `graph_digest_compared`), with Epic coverage deferred by `docs/contracts/workflow-graph.md:17`;
- 4 was half carried;
- 5 was not carried.

The gaps became debts: debt 7 (#229) closed criterion 4, and debt 2 (#219) closed criterion 5.

To do, after 7l: re-measure all five on the final series, each by a command. Record the result in §8, with the carrier `file:line` and the command output. The owner moves the slice to done.

### 2.3 Debt 8a: the final panel roster is pinned to the old guide

**What is pinned.**
- `scripts/validate-design-candidate.mjs` `REQUIRED_PANEL` requires:
  - astra: `openai-codex/gpt-6-astra`, low;
  - grok: `cursor/cursor-grok-4.6`, xhigh;
  - muse: `meta/muse-spark-1.3-contributor`, xhigh;
  - deepseek: `deepseek/deepseek-flash`, max.
- The guide in force since 2026-09-25 (anchor 21) seats:
  - lead: `claude` / `opus` (Opus 5.5), max;
  - `devin` / `swe-2-max`, with the effort encoded in the model id;
  - `pi` / `meta/muse-spark-1.3-contributor`, xhigh;
  - `pi` / `deepseek/deepseek-flash`, max.
- `PANEL_BY_ROUND` pins no roster for round 5, so `validatePanelRound` answers "no roster is pinned for it".
- The old routes are also pinned in `scripts/validate-governance-bundle.mjs`, `scripts/validate-provider-preflight.mjs` and the tests `validate-design-candidate`, `runtime-governance-bundle`, `runtime-bundle-panel`, `runtime-provider-preflight` and `runtime-panel`.

**Scope.**
- Measure every place the roster is pinned.
- Move `REQUIRED_PANEL` and its copies to the anchor-21 roster.
- Rounds 1 to 4 are still checked against the rosters they sat on; `GUIDE_PANEL` is the precedent from between rounds 3 and 4.
- Round 5 is added to `PANEL_BY_ROUND` once the round is held and recorded, as the validator's own comment says.
- Not in scope: the panel itself, and the verdict schema unless the measurement shows it is needed. The validator is outside the candidate, but `design-candidate.schema.json` is inside it: editing the schema moves the digest.

**Acceptance.**
- `validate:design-candidate` accepts four `pass` verdicts on the anchor-21 routes and rejects them on the old routes, and a test shows it.
- The records of rounds 1 to 4 still pass.
- `npm test` and the validators are green, and so is the mutation job if `src/host` is touched.

### 2.4 Final panel #39: round 5, then stop

- **Method, owner instruction of 2026-09-25.**
  - Run the panel with the `traycer-artifact-critique` skill, on the four anchor-21 seats of §2.3.
  - Each seat is a separate fresh agent with its own lens, and all four are created in one barrier.
  - Each seat writes its findings as a review artifact.
  - Merge, triage and the lead's narrow re-review follow the guide.
  - Outcome: attestation `pass`, milestone Design-ready.
- It runs on the design candidate at its digest after 7l, 8 and 8a; every patch moves `candidate_digest`.
- Record the round in the repository as the validator requires: `resources/design-candidate/panel/`, `required_panel` and `attestation` in `design-candidate.v1.json`, and round 5 in `PANEL_BY_ROUND`.
- The four seats run on harnesses in the owner's local Traycer environment. If this session cannot reach those exact routes, stop and report. Do not substitute routes or models.
- Stop once the panel attests `pass`, and do not start the next phase: #40 forbids the implementation backlog before a new PASS. The tails after the panel wait for the owner: `budget-baselines-trusted`, #10 criterion 2, and #37.

## 3. How each debt is run

1. Branch from the current `main`, in a clean worktree.
2. Measure first, by running code. Whenever a form could refuse or re-identify something accepted before, measure the upgrade path too, with open pinned tasks and held distributions; this is the lesson of debt 7h. Write the decision before code, with the forms not taken and why.
3. Write the red tests first, then the fix. Then run mutants: each must die on its test file and on the full daemon suite, and each mutant's log holds only its own diff.
4. Do the five-path ripple (§4) and the full verification.
5. Get an independent review. Cross-family review is mandatory, and self-review does not close a ticket. A reviewer from the same model family does not satisfy it. If this session cannot get a review from another model family, open the PR with CI green and stop for the owner's decision; do not merge.
6. Handle findings.
   - Medium or above blocks: fix it in a fix round, then get one narrow re-review from the same reviewer.
   - A Low is fixed in a fix round that happens anyway; otherwise it is carried into the next debt that edits the same file.
   - A pre-existing defect found on the way becomes its own debt, measured first.
7. Commit only the approved tree onto the recorded base, with no hooks changing it. Then:
   - open the PR;
   - run CI: push, pull_request, and a `workflow_dispatch` of `validate-traycer-parity.yml`;
   - merge with `gh pr merge <n> --merge --match-head-commit <sha>`;
   - confirm that `main` CI is green and the mutation baseline is unchanged.

**CI lesson.** The `workflow_dispatch` run of "Validate program design registries" carries the mutation job. If that dispatch run starts before the pull_request run of the same workflow, a watcher that reads the latest run per workflow reports green too early. Before merging, confirm the dispatch run by its id: completed, success, the mutation job a success, and the baseline counts of §1.

## 4. The autosk compatibility series

- **Prepare.** Run `node scripts/prepare-autosk.mjs <new empty directory>`; its write-tree must equal the manifest's `result_tree`. The script compares real paths, so give it a path that is not behind a symlink (on macOS, `/private/tmp/…`, not `/tmp/…`). The read-only fetch it makes from `wierdbytes/autosk` is allowed.
- **A new patch** is the diff of your edits against the prepared tree. Write it to `compat/autosk/patches/00NN-<slug>.patch` and append it last to the manifest with its sha256. `result_tree` is recomputed by preparing again from an empty directory. A patch on `main` is never edited in place; the tip patch of an open PR may be rewritten.
- **The five paths** that move with a patch:
  - the patch;
  - `compat/autosk/manifest.v1.json`: the entry and `result_tree`;
  - `test/prepare-autosk.test.mjs`: the `result_tree` pin and the ordered list;
  - `docs/runtime/autosk-compatibility.md`: a row with the new tree marked "the current result_tree", with the marker taken off the previous row;
  - `resources/design-candidate/design-candidate.v1.json`: only `/files/7/sha256`, set to the manifest's sha256, and `/candidate_digest`, written as `JSON.stringify(value, null, 2) + "\n"`. `git diff --stat` shows 2 insertions and 2 deletions, and `validate:design-candidate` passes.
- **The lock.** `validate:runtime-identity-lock` keeps `requirements=25` and the lock digest, and `counted_across` equals the number of patches. Every anchored line stays byte-identical, text and indentation; a try block around an anchored line re-indents it.
- **Suites in the prepared tree.**
  - Run `cd daemon && bun install --frozen-lockfile`, then `bun test` and `bun run typecheck`. The store tests need `AUTOSK_STORE_LOCK_BIN` pointing at a helper built with `go build ./cmd/autosk-store-lock`; build it without `GOFLAGS=-mod=mod`.
  - Run `go test ./...`. A first run may show the cold-start timeouts `TestAutoInit_NonTTYCreatesProject` and `TestAutoSpawn_ReadSucceeds`; they pass alone and on a rerun.
  - Run pi-tools' `bun test` and its typecheck.
- **Suites in the repository.** Run every `npm run validate:*` (46 of them), then `npm test` last and alone. Under heavy load, `test/runtime-preflight-runner.test.mjs` and `test/measure-design-inputs.test.mjs` can miss wall-clock checks; rerun them alone.
- **Build reproducibility.** A fresh prepared tree of `3f3051a7` builds autoskd `3ae1a649ae3649d8e59be8a638dc01d0b90cb6604a04cd4baeda7382502dd430` with `bun build --compile core/src/index.ts`. Label every binary with the write-tree of the tree it came from.

## 5. Standing constraints

- No force push. Never bypass branch protection or a tool limit: on a policy block, record the exact error and stop.
- Never write to `wierdbytes/autosk`. Reading it is allowed.
- Publish no secrets and no private archives. Do not widen token scopes. Make no purchases, plan changes or paid dependencies, and no deploy to real users.
- Run autoskd, autosk or any test that spawns the daemon only with `HOME` set to a fresh directory of your own, never the real `HOME`, not even for `--version`:
  - put `AUTOSK_SOCK`, `TMPDIR` and `AUTOSK_STORE_LOCK_BIN` inside it, and set `AUTOSK_NO_AUTO_INSTALL=1`;
  - start autoskd only as `serve --tcp 127.0.0.1:0`; without `--tcp` it listens on `0.0.0.0:7077`;
  - leave no daemon running.
- Bug fixes are test-first. Add no dependency and update none. Never use `git stash`. Never fabricate a PASS. Take timestamps only from measurements.
- One active item at a time: the next one starts when the previous is merged and `main` is green.

## 6. Bug-fix method, summarized

- A bug-fix ticket starts from an established root cause with runtime evidence attached. Verify the repro once on your surface. If the cause is not established or the evidence does not reproduce, stop and report; never investigate and fix in one step.
- A bug you cannot reproduce you cannot prove fixed. Reproduce it on the matching surface.
- Write the failing test before the fix. After the fix, the original repro passes on the same surface.
- Ship the smallest change the evidence justifies; a guard that only "might help" does not ship.
- Report what was broken, the root cause with its evidence, the fix, and the failing and passing runs with their commands.

## 7. State that lives only on the owner's machine

The owner's machine holds the orchestration ledger, the evidence directory of every dispatch, and the Traycer artifacts: tickets, the debt-closing sequence and the panel records. None of it is in this repository, and this file summarizes what a cloud session needs. Ask the owner for anything missing rather than inferring it.

## 8. Handoff log

- 2026-09-26: local orchestration paused on the owner's instruction at the start of debt 7l; `main` is `dd29a03`, green. Next: debt 7l (§2.1).
- 2026-09-26, cloud session. `main` is `c917b32`: the merge of this file (#245) on top of `dd29a03`; no code moved.
  - Owner decisions for this session:
    - Cross-family review (§3, step 5) is waived for the remaining debts: a debt merges once CI is green. Each debt still gets an independent review by a fresh reviewer of the same family, and the PR says so.
    - The anchor-21 harnesses are not reachable from the cloud, so final panel #39 runs as a cloud round: four fresh Claude Code seats on `opus`, effort `medium`, one lens each, recorded with the routes they actually ran on. The attestation stays what the validator computes (`pending_final_panel`); no `pass` is written.
    - No deadline.
  - Where this file and the repository disagree (the repository wins):
    - `scripts/prepare-autosk.mjs` resolves the output path with `path.resolve`; it does not compare real paths.
    - The rosters pinned in `scripts/validate-governance-bundle.mjs`, `src/host/governance-bundle.mjs` and `scripts/validate-provider-preflight.mjs` are the rounds 1 to 3 owner roster (opus, astra `high`, grok, muse `max`), not `REQUIRED_PANEL`.
    - Debt 8a needs the schema: the route and effort enums of `design-candidate.schema.json` refuse the anchor-21 seats before the validator's roster is consulted.
    - On linux-x64 the `autoskd` sha256 of a tree depends on the `--outfile` name, so `3ae1a649…` does not reproduce here.
  - This container runs as uid 0. Two tests fail here deterministically and pass on CI: `a read made unreachable by chmod refuses the measurement by name` (`npm test`) and `an I/O failure mid-move still throws` (daemon). With `AUTOSK_NO_AUTO_INSTALL=1` set as §5 requires, the five first-run bootstrap tests fail too; they pass with it unset (their installer is injected). The isolated `HOME` lives under `/tmp/ak.*`, because a unix socket path is limited to 108 bytes.
  - Debt 7l: patch `0051` makes one formatter total, `errMsg` in `engine/types.ts`, used by the RPC mapping, the loader, the served-distribution recorder, the registry and the daemon's reload/shutdown/idle catches, and closes R7k-8, R7k-9 and R7k-10. `result_tree` `dbc2a8d2e4fc2bc5c1ce97ab24fa9487e03f3256`, 49 patches, lock `requirements=25` `counted_across=49` with the same `lock_digest`, `candidate_digest` `7dc17b70b22f7a8f11d1f1ced1b7ca3ab214b1a5944b463894c2a0a715140d13`.
  - Found on the way, candidate debt 7m, to be measured first: a definition field that starts throwing after registration (a `steps` accessor) is read by the hazard pass. At first open (`applyLoadedRegistry`) the throw fails the project open; on an `ext add`/`remove` reload it now degrades to not-reloaded (0051), and an explicit `extension.reload` answers the error. This is not a formatting failure, so it is outside 7l.
- 2026-09-26: debt 7l merged (#246, merge `a24fe2f`). CI on `main` is green; its mutation job gives the §1 baseline unchanged. The owner approved one substitute: this session's GitHub integration cannot start `workflow_dispatch` (403 `Resource not accessible by integration`), so for a PR that leaves `src/host` alone, `npm run mutation-report` is run locally on the PR head and compared with §1, and `main`'s mutation job runs after the merge. A PR that touches `src/host` runs the mutation job inside the PR (`host-changes`). The same entry carries Low R7l-5 into the next patch that edits `docs/extensions.md`: the doc names `task.enroll` as the one place a Proxy's trap error reaches the caller, and `runOnTransit` serves `task.resume` too.
- 2026-09-26: item 8 (§2.2), slice s6-migration re-measured on the final series: 49 patches, `result_tree` `dbc2a8d2e4fc2bc5c1ce97ab24fa9487e03f3256`. Every suite ran in a prepared tree with an isolated `HOME`. All five criteria are carried; criterion 3 is carried per task, and the Epic-level lock is deferred as before.
  1. **An unsupported pair fails closed, with no partial writes.**
     - Carriers: `daemon/core/test/engine.migration.test.ts:315`, "a refused plan writes nothing at all" (patch `0007`), and `:272`, "a refused rollback writes nothing either" (`0009`).
     - `bun test test/engine.migration.test.ts -t 'writes nothing'`: 2 pass, 0 fail.
  2. **A crash at every phase is recoverable, and every phase has a test.**
     - The phases are those of `Store.applyMigration` (`daemon/core/src/store/store.ts:1733`, listed at `:1720`), after `beginMigration` (`:1616`):
       - open: `test/store.migration.test.ts:70`, "reopening finds the same one", and `test/engine.migration-runner.test.ts:155`, "an open receipt is finished, not re-planned";
       - move: `store.migration.test.ts:83` and `:214`;
       - read back: `:112`, "died after the moves, before sealing", and `:165`, "read-back refuses a task that never reached the target";
       - seal: `:138`, "applying twice changes nothing the second time";
       - an open reversal: `engine.migration-runner.test.ts:247`.
     - Those tests: 6 pass, then 2 pass, 0 fail.
  3. **An active Epic continues on its admitted graph or stops.**
     - Per task, the lock anchors `graph_digest_compared` (`0005`, `engine/runtimeIdentity.ts`) and `document_digest_in_shape` (`0032`, `extensions/graph.ts`) hold: `validate:runtime-identity-lock` gives `requirements=25 counted_across=49`, `lock_digest` unchanged.
     - Behaviour, all in `test/engine.runtime-identity.test.ts`:
       - `:603`, "a workflow built from data outside its distribution cannot change under a task";
       - `:790`, "a hot reload between two steps does not let the task continue on new code";
       - `:455`, "a registry swapped mid-session parks the task";
       - `:895`, "two Epics run concurrently on different distributions, each on its own";
       - `:271`, "dispatch parks a work task whose distribution changed under it".
       - Result: 5 pass, 0 fail.
     - The Epic-level lock stays deferred by `docs/contracts/workflow-graph.md:17` ("the lock that binds an Epic to a graph").
  4. **Rollback does not substitute the identity.**
     - Carriers: `daemon/core/src/engine/migration-runner.ts:278` (rollback) and `daemon/core/src/store/store.ts:1765` (apply) refuse a task whose document is not the receipt's source.
     - Tests: `test/engine.migration-runner.test.ts:313` and `:377`, 2 pass, 0 fail.
  5. **A mutation run is mandatory when host modules change.**
     - Carriers: `.github/workflows/validate-traycer-parity.yml:217-244` (the `host-changes` gate) and `:254` (the `mutation` condition).
     - The gate, reproduced on local commits over `a24fe2f` (never pushed): a docs-only commit gives `runs=false`, and a commit touching `src/host/quick-flow.mjs` gives `runs=true`.
     - `scripts/mutation-report.mjs:247`, `pairs()`, refuses an unpaired host module by name: `Error: host modules with no paired runtime test: src/host/zz-untested.mjs`, exit 1.
     - On `main` `a24fe2f` the mutation job ran and gave the §1 baseline.
  - Moving the slice to done is the owner's call.
- 2026-09-26: item 8 merged (#247, merge `67653f5`).
- 2026-09-26: owner decision, this session: the cloud session takes the recommended option itself wherever a decision is needed, without stopping to ask, and carries the project on to full implementation. This lifts the stop at panel #39 (§2.4) and #40's hold on the implementation backlog. The cloud panel is still recorded honestly, and the attestation stays what the validator computes. The roadmap in #40 is worked phase by phase after the panel, one item at a time as in §5, each through §3.
- 2026-09-26: debt 8a (§2.3). `REQUIRED_PANEL` moves to the anchor-21 seats. The seats are `opus` on `claude`/`opus` at `max`, `devin` on `devin`/`swe-2-max`, `muse` on `pi`/`meta/muse-spark-1.3-contributor` at `xhigh`, and `deepseek` on `pi`/`deepseek/deepseek-flash` at `max`.
  - Each seat now pins its `harness`. Two seats share `pi`, and the lead's route is the bare alias `opus`, so seat, route and effort alone do not name a seat.
  - Devin's effort is `in_model_id`: the model id carries it, and claiming `max` would claim a knob the harness does not have.
  - The schema needs the change, as recorded above. It adds a `harness` enum and makes it required, and adds seat `devin`, routes `opus` and `swe-2-max`, and effort `in_model_id`. The old values stay, so a verdict on an old route is refused by the roster, not by the shape.
  - The validator matches the harness in the attestation, in `required_panel` and in `validatePanelRound`. A roster without harnesses (rounds 1 to 3) is checked as it was written. Round 4 keeps `GUIDE_PANEL`, and round 5 is not pinned until it is recorded.
  - `candidate_digest` moves because the schema is a member: `files[85]`.
  - Reviewed by a fresh same-family reviewer: approved with four Lows. R8a-1 to R8a-3 are fixed in this change: round 4's roster now pins the harnesses its record carries, and the header and the lead-route comment were reworded.
  - R8a-4 predates 8a and becomes candidate debt 8c, measured first. `computeAttestationState` never checks that the counted verdicts come from distinct sessions, and it counts a seat that holds both `pass` and `non_verdict` as passed.
  - 6 hand-made mutants on the validator die on its test file and on `npm test`.
- 2026-09-26: candidate debt 8b measured; disposition, no change (owner's decision this session).
  - What it covers: the rounds 1 to 3 owner roster is still pinned in the release governance bundle (#37: `scripts/validate-governance-bundle.mjs`, `src/host/governance-bundle.mjs`, `src/host/bundle-panel.mjs`) and in provider preflight (#26: `scripts/validate-provider-preflight.mjs`, byte-pinned `02-architecture.md` §9, the family partition). `01-core-flows.md` §3 and `README.md:11` also name it.
  - Why no change: these are product rosters, not the #39 gate. Moving them to anchor-21 breaks their own invariants: four seats in four families, a `route_id` with one `/`, one failure domain per harness while two seats share `pi`. That is a product design change. #37 is already an owner-pending tail (§2.4).
  - For the panel: the two rosters differ, and the cloud panel's package says so, so the panel can judge it.
- 2026-09-26: candidate debt 7m measured; disposition, no patch. A definition field that starts throwing after registration is read by the hazard pass at open.
  - Measured live on `dbc2a8d2` with an isolated `HOME`: a task pinned to workflow `h`, and `h`'s `steps` accessor armed by a flag file once registration has landed. The first open answers `-32603 "an unprintable value"` and the daemon stays up. The next request opens the project without `h`.
  - If the installed copy changes instead, the held distribution the task was admitted under is served, and the new code is not loaded.
  - This is the limitation `docs/extensions.md` already states (patch `0050`): "An extension object whose fields start throwing after it was registered is outside it". Since `0051` it no longer crashes the daemon and no longer breaks `ext add`. Carried Low R7l-5 is unchanged.
- 2026-09-26: debt 8a merged (#248, merge `9744d36`).
- 2026-09-26: debt 8c, a gap in the attestation (R8a-4). A seat's `pass` is counted only when that seat has exactly one counted verdict, and the counted verdicts must come from distinct sessions.
  - Measured on `c1e397e` before the fix: four passes recorded from one session computed `pass` with no error, and so did a lead holding both `pass` and `non_verdict`.
  - `validateCandidate` now names each violation (`seat X carries N counted verdicts`, `session S answered for …`). A counted `fail` still blocks.
  - A record holding two counted verdicts for one seat is invalid in every state; a seat's retry on the same digest replaces its earlier entry.
  - Review (same-family): approved with four Lows, all fixed here. They were the rule's wording, a two-of-four shared-session test, de-duplicated seats in the session message, and the doc comment.
  - 3 tests (2 red on the base); 5 hand-made mutants die on the test file and on `npm test`.
- 2026-09-26: debt 8c merged (#249, merge `0dc7856`).
- 2026-09-26: panel #39, round 5, attempt 1 (cloud round; §2.4 and the owner's decisions above). Recorded in `resources/design-candidate/panel/round-5.json`, pinned as `CLOUD_PANEL` in `PANEL_BY_ROUND[5]`; not a candidate member, and not an attestation verdict. The attestation stays `pending_final_panel`.
  - Frozen: commit `0dc7856`, tree `d79cf3c7`, `candidate_digest` `1c0e9de9…`. Package `bdc36470…` (217 733 bytes), built with the clean-room run (20 groups covered by a real fault, same tree, clean), the mutation report (the §1 baseline, `report_digest` `701cee44…`), `produce:refusals` (63 of 63 cases, 0 failed), the migration seam (PASS) and `npm test` on CI at `0dc7856` (2488 pass, 0 fail, 1 skipped).
  - Seats: four fresh `claude -p --model opus --effort medium` processes started together, each with its own session and a lens from #39's body (lead, feasibility, intent, architecture), read-only tools on a worktree of the frozen commit. Observed model `claude-opus-5-5` on all four. The preface told every seat that the product rosters of #37 and #26 differ from the gate roster by the 8b disposition.
  - Verdicts: `fail`, `fail`, `fail`, `fail`; 2 critical, 7 high. Every blocking finding below was re-measured on the frozen tree and holds.
  - Triage, canonical ids, and the debt each one goes to:
    - R5-1 (critical, feasibility and architecture): `02-architecture.md:145` and package §1 say the pinned series supplies ADR-023 and ADR-025; no patch and no host module carries any of their primitives (`UserDecisionRecord`, `authorityGuard`, `appendIntentEvent`, `integrateApproved`, `orchestrateChildBatch`, the protected heads). With R5-2 (high: `REQUIRED_DAEMON_CAPABILITIES` names only `task.creation-binding`, so the fail-closed rule of 02 §3/§4 is not what the preflight checks), R5-3 (high: 02 §3 maps the custody helper to `0016`–`0022`, `0024`, which are the store-lock helper; `src/git/ref-custody-helper.ts` does not exist), R5-4 and R5-5 (medium: package §5 does not name these absences): debt **9a**.
    - R5-6 (high, architecture): `integration_authorization_required` and 11 other vocabulary entries name a document validator (`scripts/validate-*.mjs`) as their producer, so the producer check passes on a script that validates prose: debt **9b**.
    - R5-7 and R5-8 (high, lead) and R5-9 (medium): the graph's Epic path is still `accept → integrate → aggregate_verify` with no staging, acceptance, single target CAS, read-back or delivery-profile branch, and `completion_predicate_unmet` and epic-staging's 11 classes are in neither the graph nor the vocabulary. This is #230 (P0 in #40's audit): debt **9c**.
    - R5-10 and R5-11 (high, intent) and R5-12 (low): five post-v1 contracts (#28, #29, #30, #31, #33) and #47 call their runtime `required_for_v1` against the matrix; Debate is not marked inactive in 01 §4: debt **9d**.
    - R5-14 (medium, three seats): `family-partition.v1.json` files Meta's `muse-spark-*` under `kimi`; R5-15 (medium): 01 §3 still presents the historical routes without 02 §9's marker: debt **9e**, measured first.
    - R5-16 and R5-17 (medium, lead): `cross-family-review.mjs` never offers `opus` and takes families as caller strings; nothing evaluates Lead selection or the Supplementary-seat rule: debt **9f**, measured first.
    - R5-13, R5-18, R5-19 (low or disclosed): no change; answered in the next package.
  - Order: 9a, 9c, 9d, 9b, 9e, 9f, each through §3, then a new freeze and round 6 on the new digest.
- 2026-09-26: debt 9a (R5-1 to R5-5): the series supplies ADR-014, not the three primitives, and the preflight now refuses until the other two are pinned. ADR-083.
  - Measured on `0dc7856`: `02-architecture.md:145` and package §1 said the series supplies ADR-014, ADR-023 and ADR-025. No patch and no module carries `UserDecisionRecord`, `authorityGuard`, `integrateApproved`, `appendIntentEvent` or `orchestrateChildBatch`. Patches `0016`–`0022` and `0024` touch `cmd/autosk-store-lock`, `internal/storelock` and the store; `src/git/` does not exist. `REQUIRED_DAEMON_CAPABILITIES` was `[task.creation-binding v2]`, and nothing outside its test imports `daemon-preflight.mjs`.
  - Fix: 02 §3 names what the series supplies (ADR-014 via `0001`/`0028`, reported by `0013`, revision 2 by `0028`; snapshot store and admission; creation-grant signing and the artifact write adapter; the store-lock helper and trusted state writes) and, separately, the three absent surfaces as #40 obligations. `daemon-preflight.mjs` splits `PINNED_DAEMON_CAPABILITIES` from `UNPINNED_DAEMON_PRIMITIVES` (`authority.user-decision` ADR-023, `workflow.custody` ADR-025). An unpinned entry is never satisfied, so the default preflight refuses every daemon, the series' own included, with `daemon_capability_missing`. The shipped-source test now also fails if the daemon starts declaring an unpinned name. Package §1 and a new §5 bullet say the same, the names read from the module.
  - Not invented: no method names for ADR-023/025; the design does not specify their RPC surface.
  - Review (same-family, fresh process): changes requested, one Medium and four Lows, all fixed here. R9a-1: the requirement was a defaulted parameter, so passing the pinned set or `[]` admitted the series' daemon; `requireDaemonCapabilities(report)` now takes no requirement, reading moved to `readCapabilityReport`, and a pinned revision or method mismatch is reported before the unpinned `missing`. R9a-2 to R9a-5: the store-lock patch wording (`0019` is trusted-state writes), `creation-grant.md` §6 and `docs/runtime/creation-contracts.md` describe the pinned/unpinned split, ADR-072 points at ADR-083, and the package names `F017`–`F020` from the matrix.
  - Narrow re-review: approve; its two Lows (R9a-6: `creation-grant.md` §6 said a missing capability carries versions; R9a-7: "default" wording left over) are fixed here.
  - Verification: 46/46 validators; `npm test` 2494 pass (the uid-0 exclusion aside); mutation report `daemon-preflight.mjs` 52/52, 16 survivors all named (the baseline); hand-made mutants P1–P6 and B1–B4 each die on their own test file and on `npm test`.
  - `candidate_digest` `1c0e9de9…` → `b4b631be…` (members `02-architecture.md`, `04-decisions.md`, `docs/contracts/creation-grant.md`).
- 2026-09-26: debt 9d (R5-10, R5-11, R5-12): a contract states the lifecycle the matrix gives its issue.
  - Measured on `0a95de7`: the Status and "Deferred and named" lines of `autobuild-run.md` (#28), `reflect-cost-watch.md` (#29), `housekeeping.md` (#30), `debate.md` (#31) and `walkthrough.md` (#33) said their runtime remains `required_for_v1`; matrix v1 classifies all five `planned_after_v1`, release-blocking no. `static-analysis.md` (#47, outside the #3–#39 inventory) said `required_for_v1` with no successor matrix. No validator read these lines. `01-core-flows.md` §4 presented Debate as selectable with no v1 marker.
  - Fix: `validateContractStatuses` in `scripts/validate-program-capability-matrix.mjs` reads every contract's Status and "Deferred and named" lines and refuses a lifecycle token that differs from the matrix record of the contract's issue, and any lifecycle token for an issue outside matrix v1. The six contracts now say `planned_after_v1`, and #47 says it is a successor-matrix candidate that blocks neither v1 nor the release and that its two registered artifact classes (`static_analysis_policy`, `static_analysis_result`) activate nothing. 01 §4 marks Debate inactive in v1, with the user's ordinary human decision as the v1 path.
  - R5-13 (Low: post-v1 contracts carry full refusal sets): disposition, no change; all six (`sdk-write-api.md`, #38, included) are labelled `planned_after_v1` now, which is the condition the seat named.
  - Review (same-family, fresh process): approve with four Lows, all fixed here. R9d-1: `sdk-write-api.md` gets the post-v1 label. R9d-2: a status naming no issue may not state a lifecycle (refused, not skipped), and `issue #N` is matched case-insensitively. R9d-3: every issue a status names is held to the claim, not only the first. R9d-4: the #47 status says what is true of its two registry classes (no artifact at their paths, no v1 producer), and ADR-067 records that #47 is outside matrix v1.
  - Seven hand-made mutants on the new check die on its test file and on `npm test`.
- 2026-09-26: debt 9e (R5-14, R5-15): a model sits in its own line's family, and 01 §3 marks its roster tables historical as 02 §9 does. ADR-080 addendum.
  - Measured on `7979f54`: `family-partition.v1.json` listed Meta's `muse-spark-1.3` and `muse-spark-1.3-contributor` under `kimi`, next to `cursor-kimi-2.5`. So the Intent seat `meta/muse-spark-1.3-contributor` resolved to `kimi`, and `REQUIRED_PANEL` spanned `gpt, grok, kimi, opus`. 01 §3's seat table (GPT-5.6 Sol, Grok 4.6, Kimi K3, Opus 5) and author-set table had no marking, while 02 §9 marks the same routes historical. §3 and §6 stated the master order GPT, Kimi, Grok, Opus, and nothing compared it with `master_order`. No validator read `01-core-flows.md` for either claim.
  - Fix, partition: a fifth family `muse` (display Muse, "Meta's model line, served as meta/ and cursor/") takes both muse-spark models. `kimi` keeps `cursor-kimi-2.5`, which the unavailable-route example of provider preflight names. `master_order` is `gpt, kimi, muse, grok, opus`. The pairwise order of the old four holds and a family with no seat is skipped, so in the live roster Muse takes Kimi's slot (Codex authorship gives Lead Muse). `REQUIRED_PANEL` routes and efforts are unchanged (8b).
  - Fix, documents: 01 §3 carries `<!-- panel-roster-historical:v1 -->` and a bold statement before its first table: both tables are historical target intent, the live roster is only `REQUIRED_PANEL`, the family comes from the partition, and the live Intent seat is Muse. §3 and §6 state the five-family order, and §6 gains a Muse row. 03 marks its Lead table historical and states the order with Muse. README names GPT, Grok, Muse and Opus. 02 §9 and its byte pin are untouched, and neither pinned anchor is copied into 01.
  - Fix, validator: `validate:provider-preflight` now loads `01-core-flows.md`. `flowsRosterMarkingErrors` requires the marker once in §3, before the section's first table row, followed by visible lines naming `историческое целевое намерение` and `REQUIRED_PANEL`. Comments are stripped, a NUL is refused, and the four named kinds of line that do not render are refused by name; 01 §3 has no byte pin, so a reworded claim is caught by review, not by the check. `masterOrderProseErrors` requires the §6 bold list to equal `master_order` by display name.
  - Tests: 5 red on the base in `test/validate-provider-preflight.test.mjs` (the family test, the four-families test, the §3 marking test, the §6 order test, the one-prefix test), plus one test for the §3 scoping edges. 15 hand-made mutants on the new checks die on the test file; the one that first survived (a claim above the marker counted) gave the claim-above-marker case.
  - Verification: 46/46 validators; measured inputs up to date (236); `produce:refusals` 63 of 63, 0 failed; `npm test` 2502 pass, 1 skipped (the uid-0 exclusion aside); mutation report `modules=51 mutants=1780 killed=1764`, 16 survivors all named, `environment_failures=0`, `report_digest` `a884c948…` (unchanged since 9a; no `src/host` change).
  - `candidate_digest` `e3a0147f…` → `afe7d77d…` (members `01-core-flows.md`, `03-technical-plan.md`, `04-decisions.md`, `README.md`, `resources/panel-roster/family-partition.v1.json`).
  - Review (same-family, fresh process): approve with nine Lows. Fixed here: R9e-1 (01 §6 now says a family with no seat or no available exact route is skipped, so Muse is first for Codex), R9e-6 (the `familyOf` docstring), R9e-8 (this entry's wording), R9e-9 (a missing `notEqual` guard in the §6 test). Carried to debt 9f, which replaces them: R9e-2 (03's code-reviewer table and `REVIEWER_ORDER` still read GPT → Kimi → Grok; no candidate is sealed for a panel round between 9e and 9f) and R9e-3 (the Cursor failure-domain comment in `src/host/provider-preflight.mjs`; 04:606 is history). Dispositioned, no change: R9e-4 (02 §3 diagram names the seat task `kimi`), R9e-5 (the drawio panels and the matrix's verification text name the historical GPT/Grok/Kimi/Opus panel, labels of the recorded roster), R9e-7 (only the §6 bold order is checked; the §3 order and the rows are held by review).
- 2026-09-26: debt 9c (R5-7, R5-8, R5-9; #230): the Epic's integration order is in the workflow graph, not only in the prose. ADR-084.
  - Measured on `620aa58`: the graph ran `ticket_join → accept → integrate → aggregate_verify → cleanup` (`t_352`, `t_353`, `t_357`, `t_360`, `t_369`). `integrate` moved the target once per Ticket (`t_362`, one `integrateApproved` per step) and the aggregate ran after it. There was no staging step, no acceptance of the verified staging identity, no read-back and no delivery-profile branch; `completion_predicate_unmet` and ten of epic-staging's eleven classes were in neither the graph nor the vocabulary; `cond_262` and 01 §7 spoke of a completed prefix and remaining transitions.
  - Red first: `test/workflow-graph-epic-integration.test.mjs` (19 tests: order, the two gates by reachability, what each gate reads, one CAS and its read-back, the delivery branch, resume, eight negative controls, the owners of the new reasons, the prefix wording, and a host characterization), and `t_366`/`t_367` left `PARKS_WITHOUT_A_NAMED_REASON`. On the unmodified graph 18 of the 19 and the named-reason test failed; the host characterization is green by design.
  - Fix: five agent steps, `apply_staging`, `accept_staging`, `integrate_staging`, `verify_target` and `deliver_staging`. `t_352` enters `apply_staging`; `t_369` enters `accept_staging` and reads the aggregate binding and the staging commit/tree. 31 edges `t_544`–`t_574` (guards `guard_548`–`guard_578`, predicates `cond_423`–`cond_453`); the Epic's 12 per-Ticket edges are gone with their guards and predicates, and `t_362` stays as Quick's resume edge at priority 18. `accept`, `integrate` and `integration_recovery` are Quick's only.
  - Vocabulary 85 → 98: epic-staging's ten (not `aggregate_failed`, which is `aggregate_verify_failed`, as `epic-staging.md` §8 now says), `completion_predicate_unmet`, `unsupported_integration_mode` and `delta_stale`, each `host` with the `src/host` files that emit it. 13 recovery rows; park table +13 rows, core-flows resume table +5.
  - Prose: 03 §2 chains, the Epic and Quick transition rows and §5 Integration; 01 §7 (one ref transition, no partial CAS); `integration-authorization.md` §2–§7; `02-architecture.md` (integration-state keeps the CAS operation and its outcome, no prefix); the counts in `workflow-graph.md`, `workflow-factory.md`, `refusal-vocabulary.md` §5 and §6 and the graph schema's `handled_at` description. Seven `produce:refusals` cases addressed entries by array index; they are re-pointed at the entries their notes name.
  - The record, narrowed in the same debt (the coordinator's follow-up: a multi-transition example would contradict §4). `integration-authorization.schema.json` replaces `ordered_ref_transitions`, `remaining_start_index` and `completed_prefix_receipt_hash` with one `ref_transition {from_oid, to_oid}`. An object, not a one-item array, because one transition has no order or index and the validator no longer checks a chain. Both examples carry one transition from `initial_target_oid`, and the refused example still produces three classes (expired, terminal, scope). The validator's chain and prefix checks are gone. `integration_authorization_prefix_mismatch` stays because one case is still reachable: the branch is not where the one transition starts. §6 says the name is historical. ADR-069 points at ADR-084. Red: `evidence/9c/red2.log` (5 of 18 failed: two transitions, a start index, a completed-prefix receipt, the example's two transitions, prefix wording in the contract, 02 and the 03 field list).
  - Contract class count: 448, unchanged. It is the package's reader (`contractOutline`). The vocabulary validator's `closedByContract` reads 449 on the base and now: it runs past the enumeration and takes `expected_previous` from `artifact-write-receipt.md`. `refusal-vocabulary.md` §5 now names this discrepancy; it is not fixed.
  - Independent review (same family, fresh process): changes requested, one High, two Medium, five Low; all addressed here, test-first (`evidence/9c/red3.log`: 15 of 52 failed on the follow-up state).
    - R9c-1 (High): the resume layer skipped the gates. `project_boundary_invalid` named every deterministic step, so an Epic stopped at `aggregate_verify`, `ticket_join` or `select_next` could resume at `cleanup` (→ `done`) or at Quick's `accept`/`integrate`; `blocked_anchor` resumed the staging steps into `record_code_verdict`, one edge from them. Fix: `epic_boundary_invalid` (owner 03's resume table, producer daemon) for the Epic's own steps — the 41 only the autosk-planned chain draws, vocabulary class `epic_step` — resuming only into Epic steps before acceptance, and at `accept_staging` from `integrate_staging`, `verify_target` and `deliver_staging`. Nine steps and 30 guards moved from `project_boundary_invalid`; its unlendable `complete_anchor_handoff`/`repair_anchor_handoff` targets went. `blocked_anchor` lost `record_code_verdict`; `tickets_manifest_invalid` lost the three Quick/Ticket targets lent by `freeze`. Test 7 now checks every row standing in the integration segment (targets and one edge beyond, acceptance gates excepted), names the five planning-phase rows that still lend `cleanup`/`done` (04 risk 6), and has seven more negative controls.
    - Planned → Quick `integrate` through the shared review steps is still reachable in the graph. The barrier is a guard on every edge into Quick's integration reading `workflow=autosk-quick` (the `record_editorial_exemption` edges gained it), pinned by a test, with the workflow creation-bound; recorded as 04 risk 7, not closed.
    - R9c-2: a lapsed/revoked/replaced/head-mismatched authorization at `integrate_staging` is `acceptance_stale`, resumed at `accept_staging`; `integration-authorization.md` §5 and 02:230 say an Epic never parks `integration_authorization_required`; 03's test line fixed. R9c-3: `staging_moved_after_pass` resumes into `apply_staging` through a new resume edge `t_575` (`guard_579`, `cond_454`); `t_561` now serves `aggregate_binding_void` only. R9c-4: the Quick integration commit is built from a recipe fixed before signing, and `planErrors` refuses a Quick record with other than one reviewed candidate. R9c-5: the CAS edge's `cond_441` reads `staging_acceptance` and `controlling_anchor_digest`. R9c-6: `workflow-graph.md` §8, the validator and its test cite `t_481`/`t_567` instead of the deleted `cond_272`/`t_367`, and a test keeps cited ids declared. R9c-7: the residuals are 04 risks 6–9 and ADR-084. R9c-8: the new files are `test/workflow-graph-epic-integration.test.mjs` only; everything else is modified.
  - Narrow re-review: R9c-2 to R9c-8 resolved; changes requested on four (`evidence/9c/red3b.log`: 16 of 231 failed before the fix).
    - R9c-9 (High) and R9c-10 (Medium), decided by the coordinator: the resume scope is enforced by the mechanism, not the prose. A recovery row may declare `resume_scope: "origin"`: a resume is permitted only into the step the park recorded as its origin (for a task on the `human` step, the origin its graph park wrote; an engine park writes none — R9c-13). Schema field closed; the validator refuses an origin-scoped row whose target is not one of its own steps (`resume_target_not_permitted`); `src/host/workflow-factory.mjs` writes `park.origin` before `park.reason` and `permitsResume` refuses any other target, after the target list and before the lending rules. Both boundary rows are origin-scoped. `epic_boundary_invalid` now names `human` and the shared steps an Epic stands on, and every Epic step resumes into itself, the post-acceptance ones included (only `integrate_staging`'s guards re-check acceptance and anchor, and its CAS is idempotent — corrected in R9c-16). Test 7b now covers `human` and the shared steps, is origin-aware, and excuses one edge beyond a landing only when that edge's guards read the workflow; `no_external_reviewer` is keyed to `workflow=autosk-quick|autosk-ticket` and checked so. New assertions: no stop before the PASS resumes into `accept_staging`, and `aggregate_verify` is re-entered only past the apply; nine per-route negative controls.
    - R9c-11: a staging move found at `aggregate_verify` is `staging_moved_after_pass` too (`t_576` park, `t_577` resume into `apply_staging`); `aggregate_binding_void` keeps config, lock and Ticket-set drift. R9c-12: `project_boundary_invalid` is named at the new class `non_epic_deterministic_step`; 03's generic boundary row and the `authority_recovery` row say what an autosk-planned task records.
  - Second narrow re-review: R9c-9 to R9c-12 resolved; changes requested on four, R9c-17 kept as risk 7 (`evidence/9c/red3c.log`: 16 of 243 failed before the fix, plus the new named-leak control failing against the round-3 detector).
    - R9c-13 (Medium): `park.origin` could go stale. A take inside a row kept the reason and the origin, and the Epic's boundary row names nearly every Epic step, so after a resume into origin `aggregate_verify` and `t_369` an engine park at `accept_staging` could not re-enter and could only rewind behind the PASS. `run()` now treats a scoped row's surface as its origin: a take anywhere else clears `park.reason` and `park.origin` in one `autosk metadata unset` (the CLI takes several keys in one write). `workflow-factory.md` §4 says an engine-side park writes neither leaf, and a daemon-side writer of a scoped reason writes the step the task stands at as `park.origin` before the reason, overwriting any origin, except on the `human` step, which only a graph park reaches. Runtime test: boundary park at A, resume A, take A→B inside the row, engine park at B; B is admitted, A refused.
    - R9c-14 (High): the three planning-ref rows park at `cleanup` beside the Epic's planning steps, so a planning stop was lent `cleanup` and `done`. They are origin-scoped now, with their targets narrowed to the steps they name (dropped: `done`, `select_next`, `ticket_join`, `dispatch_*`, `human` and the rest, none of which any table row names as a recovery step). Test 7b escalates a named row's leak into any of `RESUME_FORBIDDEN`, and `KNOWN_PLANNING_RESUME_LEAKS` is empty and pinned.
    - R9c-15 (Medium): neither origin scope (re-entering `narrow_review_join` hits the cap again; the Planned recovery is `fix_artifact`) nor narrowing the union (it would take `rebuild_code_anchor` and `invalidate_quick_classification` from Quick/Ticket) fits `review_cap`, so `resume_scope` gains `origin_edges`: the origin and a listed step an edge out of it reaches. `review_cap` resumes from `narrow_review_join` into `fix_artifact`, and from `record_code_verdict` into `fix` (the table's Quick/Ticket step, which the union could not list without lending it to Planned), `rebuild_code_anchor` or `invalidate_quick_classification`; the receipt-only targets went. `artifact_mapping_required` keeps the union and loses `done`, which only `invalidate_quick_classification`'s receipt lent and no stop under the reason reaches. A runtime test shows the Quick/Ticket resumes still admitted.
    - R9c-16 (Low): `epic_boundary_invalid`'s required_state and its 03 row now say acceptance and anchor are re-checked at `integrate_staging` only; risk 8 names the `deliver_staging` hand-off window (a `blocked_anchor` edge before the hand-off, like `t_564`, is named as the possible closure, not added).
  - Verification (after the second narrow re-review): 46/46 validators; `produce:refusals` 63 of 63, 0 failed; `measure-design-inputs --check` up to date (236 inputs); `npm test` 2556: 2554 pass, 1 skipped, and the uid-0 failure. Mutation report: `modules=51 mutants=1788 killed=1772 survivors=16 named=16 killed_by_timeout=4 named=4 environment_failures=0`, `report_digest=da27fe49…`; `workflow-factory.mjs` 90/90, no new survivor; nine hand-made mutants of the new guards each die on `test/runtime-workflow-factory.test.mjs`. Before it: `npm test` 2544: 2542 pass, 1 skipped, and the uid-0 failure. `src/host/workflow-factory.mjs` changed, so the mutation report ran: `modules=51 mutants=1783 killed=1767 survivors=16 named=16 killed_by_timeout=4 named=4 environment_failures=0`, `report_digest=f1da2e55…`, against the §1 baseline `mutants=1778 killed=1762`: five new mutants, all in `workflow-factory.mjs` (85/85), all killed, no new survivor. The stale "eighty-five" comment at `workflow-factory.mjs:418` now says ninety-nine (comment only; the module rerun gives the same 85/85).
  - Digests: graph `canonical_digest` `2a38be31…` → `12257c05…` → `3646424f…` (no live Epic runs on the old graph); `vocabulary_digest` `587ec19f…` → `cbbf78d0…` (99 reasons, six step classes; unchanged by the second narrow re-review); `candidate_digest` `b4b631be…` → `60b8122c…` → `17ac9c92…` (members 01, 02, 03, 04, `epic-staging.md`, `integration-authorization.md`, `refusal-vocabulary.md`, `workflow-factory.md`, `workflow-graph.md`, the vocabulary, the graph schema and document, the integration-authorization schema and both examples, and the two case files; `workflow-factory.mjs` is not a member) → `0673201c…` after rebasing onto main `acdb38d` (debts 9d and 9e).
  - Residuals are in 04 "Оставшиеся риски" 6–9: the reverse lending the Epic order does not touch (`artifact_mapping_required` lends a Quick/Ticket stop at `freeze` the Epic's `draft_artifact` and gives it no resume of its own; under `review_cap` a Ticket stop is admitted into Quick's `invalidate_quick_classification`), the forward Planned → Quick `integrate` path held by the workflow guard, no `blocked_anchor` edge at `verify_target`/`deliver_staging` and the `deliver_staging` hand-off window, and the 448/449 reader discrepancy.
  - Third narrow re-review: approve. Its one Low, R9c-18 (an `origin_edges` row's targets are held only by the union check), is already the right rule: a scoped park's origin is always a step its row names, so "a named step or an edge out of one" is the union check itself; a test now pins that the scope does not relax it. The orchestrator accepted `origin_edges` for `review_cap` over splitting the reason per cap, as the smaller change.
- 2026-09-26: debt 9f (R5-16, R5-17, and R9e-2, R9e-3 carried from 9e's review): a participant's family comes from the partition, and Lead and Supplementary are computable rather than only described. ADR-085 (ADR-084 is left free because debt 9c adds it).
  - Measured on `9b9692e`: `cross-family-review.mjs` kept its own `REVIEWER_ORDER` `['gpt','kimi','grok']`, so it offered Opus for no author set, while 01 §6 routes Codex, Grok, Kimi and Human authorship to Opus. `FAMILY_ALIASES` mapped `anthropic` to `claude`, but the partition's name is `opus`. `normalizeFamily` passed through any non-empty string, so `cursor`, `meta` or `claude` became a "family" that excluded no reviewer. The module never read `family-partition.v1.json`, and only its test imported it. `runPanel` gave `computeGate` the canonical findings and nothing else. Neither src/ nor scripts/ held a Lead selection or the word `supplementary`. 03 §4's code-reviewer table read GPT -> Kimi -> Grok, and the `routesInDomain` comment said that Cursor takes Grok and Kimi.
  - Fix, review routing: `modelOf` and `familyOf` moved into `cross-family-review.mjs`. `validate:provider-preflight` re-exports them, so the roster check, the code review and the panel roles all resolve families through one function. A participant is a route or a model id. The literal `human` excludes nothing. Anything the partition does not resolve is refused with the host-local `review_family_unknown`, which replaces `review_family_collision`. That covers a harness or vendor label, a tool name, an unlisted model, a missing partition and an empty author set. `reviewerRoute` ranks `master_order` minus the union of author and fixer families; the module has no order or alias table of its own now. `reviewAdmission` takes the available exact reviewer routes explicitly and refuses without them. Those are the routes provider preflight admitted, today the `REQUIRED_PANEL` routes. It keeps only ranked families that have such a route, and returns `reviewer_route`: the chosen family's first route in the order listed, since Muse is served both as `meta/` and as `cursor/`. It parks with `review_no_external_family` when no family is left. So with the live roster Codex gets Muse first, and the union Codex, Muse, Grok and Opus parks instead of going to Kimi, which has no route.
  - Fix, panel roles: `panelRoles` in `panel.mjs` picks Lead: the first `master_order` family outside the author/fixer union that holds a seat. The Supplementary seats are the ones inside the union. `runPanel` calls it before any seat runs and refuses with the host-local `panel_lead_not_external` when no seated family is external. A recorded Lead is kept while its family stays outside the union and refused once a fixer puts that family inside. `runPanel` returns `roles` and passes them to `computeGate`. Route availability does not move Lead: a seat without an admitted route makes the panel incomplete under the all-seats-answer rule, and 01 §3 and 03 §4 now say so.
  - Fix, Supplementary rule: `liftedByLead` in `finding-registry.mjs` sits above `computeGate` and below line 89, so the named survivor at :79 did not move. A critical or high raised only by Supplementary seats blocks until Lead rules, and only `lead_ruling {seat: roles.lead, outcome: disagreed}` lifts it. A finding that another seat also raised is not liftable. With no roles recorded, nothing lifts. Supersession drops the ruling and the roles, as it drops the contest, so the next candidate's roles are recomputed from its own author and fixer set. The registry schema has optional `roles` and `lead_ruling` (the reason is required). `validate:finding-registry` gates with the same predicate. It refuses:
    - a Lead that is also Supplementary;
    - a role outside the declared seats;
    - a ruling from a seat other than Lead;
    - a ruling with no recorded Lead;
    - a ruling on a finding a seat outside Supplementary also raised;
    - a ruling on a finding below high.

    Roles enter `registry_digest` once recorded, so the example's digest is unchanged. The contract gains a bullet in §7 and one in §10.
  - Not done, and named (ADR-085): no workflow path calls `runBundlePanel`/`runPanel` or `reviewAdmission` with recorded author and fixer routes yet; only tests do, mostly with a `human` author. No host primitive records a `lead_ruling`; the field is only read. The caller that passes `reviewAdmission` the preflight-admitted routes is part of the same live path. Both are implementation obligations, and 01 §3 says the rules are computable, not that a live panel applies them.
  - Fix, documents: 01 §3 now calls Supplementary the seat of the author's or a fixer's family, names the two functions and the open obligations, and says that route availability does not move Lead. In 01 §6 the row is `Human`. §6 now says that a model outside the partition is not external (`review_family_unknown`). It also says that a family without an available exact reviewer route is skipped, and that the task parks when none is left. 03 §4's code-reviewer table matches 01 §6 in the five-family order (R9e-2), and says the same about `reviewAdmission` and Lead availability. The `routesInDomain` comment says Cursor takes only Grok in the live roster (R9e-3). `REQUIRED_PANEL`, `REQUIRED_SEATS` and failure domains are unchanged (8b). The refusal vocabulary is unchanged.
  - Tests: red on the base, by test, in `runtime-cross-family-review` (6), `runtime-panel` (5), `runtime-bundle-panel` (1), `runtime-finding-registry` (2), `validate-finding-registry` (3) and `validate-provider-preflight` (1: the re-export identity). `runtime-panel` and `runtime-bundle-panel` deps now carry the on-disk partition and `authors: ["human"]`. The code-review tests take `REQUIRED_PANEL`'s routes as the available reviewers: the live product roster, gpt, muse, grok and opus through the partition, with no Kimi route.
  - Review (independent, fresh process): changes requested, two Medium and three Low, all fixed here, test first (three more red tests):
    - R9f-1 (Medium): `reviewAdmission` did not skip a family with no exact route, so it chose Kimi for Codex and admitted Kimi when Kimi was the only family left.
    - R9f-2 (Medium): the missing callers and the missing ruling primitive were not named.
    - R9f-3 (Low): supersession kept `roles`.
    - R9f-4 (Low): 03 §4 said Lead needs an available exact route.
    - R9f-5 (Low): the validator admitted a ruling that could decide nothing.
  - Narrow re-review: approve, R9f-1 to R9f-5 resolved. Its two Lows are fixed here, test first (`red3.log`):
    - R9f-6: 01 §6, 03 §4 and ADR-085 name the source of the reviewer routes (provider preflight's admitted routes, today `REQUIRED_PANEL`), and the obligation line names the caller that must supply them.
    - R9f-7: `reviewAdmission` returns the admitted exact route, so 03 §4's "первый доступный exact route" is what the code does.
  - Verification: 46/46 validators; measured inputs up to date (236); `produce:refusals` 63 of 63, 0 failed; `npm test` 2518 pass, 1 skipped (the uid-0 exclusion aside). Mutation report: `modules=51 mutants=1807 killed=1791` (9e: 1780 mutants, 1764 killed). All 27 new mutants in `cross-family-review.mjs`, `panel.mjs` and `finding-registry.mjs` are killed by their own runtime tests. 16 survivors, all named, the same 16 as before, and `finding-registry.mjs:79` stays at :79. 4 timeout kills, named. `environment_failures=0`, `report_digest` `9b7d9fec…`. Twelve hand-made mutants on the validator and the schema each die on their own test file and on `npm test`: the lift ignored, each registry refusal and the roles digest removed, the ruling reason made optional, and a second `familyOf` kept in the validator.
  - `candidate_digest` `afe7d77d…` → `e3cd3783…` → `7b25c7b5…` after rebasing onto main `a715b7c` (debt 9c) (members `01-core-flows.md`, `03-technical-plan.md`, `04-decisions.md`, `docs/contracts/finding-registry.md`, `resources/finding-registry/finding-registry.schema.json`).
- 2026-09-27: debt 9f merged (#254, merge `fe9befd`). CI on `main` is green on both workflows, including the mutation job. A new cloud session took over with a goal prompt; it re-measured `main` `a715b7c` before the merge: 46/46 validators, `npm test` 2565 (2563 pass, 1 skipped, the uid-0 failure), `produce:refusals` 63 of 63, measured inputs up to date (236), mutation report `modules=51 mutants=1788 killed=1772 survivors=16 named=16 killed_by_timeout=4 named=4 environment_failures=0 report_digest=da27fe49…`.
  - Where the goal prompt and the repository disagree: the #40 checklists and the per-issue audit comments were last updated on 2026-09-23; this log and the code are the live record.
- 2026-09-27: debt 9b (R5-6): a park reason's producer is runtime code, and a reason nothing produces says so. ADR-086.
  - Measured on `fe9befd`: `refusal-vocabulary.schema.json` let `producer_files` start with `scripts/`, and thirteen entries named a script as their producer: twelve a `scripts/validate-*.mjs` (`integration_authorization_required`, three `arena_*`, eight `planning_*`), and `review_cap` the `scripts/verify-autosk-cap.mjs` harness. The producer check passed on them, and the panel package counted them among the reasons "produced by code in this repository".
  - Fix: the schema allows only `^src/`; `producerErrors` refuses a producer file outside `src/`, ignores script emitter records, and reads only runtime files in the textual test. `producer` gains `none`: designed, emitted by nothing yet, an implementation obligation; it names no files, and runtime code that produces the code contradicts it. Eight entries are `none` (`arena_contract_invalid`, `arena_fallback_required`, `arena_reexpression_missing`, `integration_authorization_required`, `planning_candidate_base_stale`, `planning_publication_invalid`, `planning_ref_capability_missing`, `planning_ref_init_invalid`), `review_cap` is `daemon` (the takings counter is the daemon's, `0034`), four keep only their `src/host` files. The package counts host 26, daemon 65, none 8 and lists the eight in §5.
  - Considered and dropped: blanking comments with `acorn` before the textual test. It made the validator read `node_modules`, which `produce:refusals` binds and its test sandbox does not carry (the refusal-vocabulary cases went 0 of 10). Instead the one runtime comment that quoted a designed-only code (`src/host/workflow-factory.mjs`, the `cond_002` example) names the guard; comment only, `workflow-factory.mjs` 90/90 mutants killed.
  - Follow-ons: the refused example contradicts `daemon` on `acceptance_missing` (it relied on a script naming `planning_ref_init_invalid`); the `refusal_vocabulary_producer_missing` case is re-pointed from index 16 (now `none`) to index 0; the §9 count in `refusal-vocabulary.md` is 65, checked by `test/prose-counts.test.mjs`.
  - Tests: 3 red on the base in `test/validate-refusal-vocabulary.test.mjs`, 1 in `test/build-panel-package.test.mjs`. Hand-made mutants on the new check: 4 of 5 died on the test file; the survivor was a redundant emptiness guard, removed.
