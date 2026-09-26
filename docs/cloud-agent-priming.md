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
  - Debt 7l: patch `0051` makes one formatter total, `errMsg` in `engine/types.ts`, used by the RPC mapping, the loader, the served-distribution recorder and the registry, and closes R7k-8, R7k-9 and R7k-10. `result_tree` `da7b8870835b5da9c26f63a627f053547e35504a`, 49 patches, lock `requirements=25` `counted_across=49` with the same `lock_digest`, `candidate_digest` `cbed6eae250cb30776fc340a546764956fe115d0701c99ba71327d7eb7934743`. Found on the way, candidate debt 7m: `tryReload`'s `errStr` in `rpc/daemon.ts`, reachable through a definition field that starts throwing after registration.
