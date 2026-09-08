# Housekeeping contract

<!-- housekeeping-contract:v1 -->

Status: issue #30 design contract. The inventory collector, the classifier and the deletion driver remain `required_for_v1`; this pins what may be proposed, what a green classification has to be derived from, and what happens between the report and the delete.

## 1. Authority

The existing `cleanup` removes recorded paths with `force=false`. That is the easy half. The hard half is everything nobody recorded: a worktree abandoned by a crash, an orphan snapshot, a dirty tree that belongs to no current task, a detached or null branch, work that exists only in a submodule, an object that looks old and is held by a live lock, and a directory nobody can classify at all.

Housekeeping is therefore a **named command**, never a hidden side effect of finishing an Epic (`housekeeping_hidden_side_effect`). Deleting is the one operation that cannot be reviewed afterwards, so it does not happen as a consequence of something else. The closed JSON Schema is `resources/housekeeping/housekeeping-report.schema.json`.

## 2. Boundaries

The safe filesystem and Git adapters are the project's; this contract requires them and does not reimplement them. Evidence retention is #27's, external source snapshots #21's, the decision packet #35's. This contract owns the inventory, the classification, the approval and the delete.

## 3. Inventory is host-wide, and ownership is proved per object

Worktrees and branches; candidate, review and Arena snapshots; provider session directories; integration, planning and staging operations; external source snapshots; evidence and quarantine roots; locks, leases, receipts and tombstones.

Objects belonging to another project are inventoried and **not** proposed without an ownership proof for that exact object (`housekeeping_ownership_unproven`). A shared host is the normal case, and "it is under our root" is a statement about a path, not about who owns what is inside it.

## 4. Classification is derived, and a missing signal is not a safe signal

Seven classes: `in_use`, `landed`, `at_base`, `unreferenced`, `review`, `orphaned`, `unknown`.

Only `landed`, `at_base` and `unreferenced` are green — proposable in the ordinary report. `in_use` is never proposed at all (`housekeeping_in_use_proposed`). `review`, `orphaned` and `unknown` are confirmed separately, by exact identity and path, never as part of a batch.

Each class is derived from recorded signals: dirty tracked, untracked and ignored files; detached or null branch state; submodules and owned submodule branches; open or unmerged pull requests where discoverable; active task, session and operation references; whether the canonical parent still exists; protocol, runtime and evidence locks.

Every signal has three states, and the third one is the point: `yes`, `no`, and **`unavailable`**. Any unavailable signal forces `unknown` (`housekeeping_unavailable_signal_treated_as_safe`). A signal that could not be read is not a signal that says no — Git metadata missing, a PR host unreachable and a lock file unreadable all mean *we do not know*, and not knowing is not a reason to delete.

**Age is never proof of safety** (`housekeeping_age_as_proof`). Last activity orders the report; it does not classify. The abandoned worktree and the one held by a three-week-old lease look identical by age, and only one of them is safe to remove.

**Submodule work is never lost silently** (`housekeeping_submodule_work_lost`). An object with owned submodule branches or submodule commits not present in the canonical line is `review` at best, whatever the superproject looks like — a clean superproject is exactly how submodule-only work presents.

**Reclaimed size is measured, not estimated** (`housekeeping_size_unmeasured`). A report that states what will be freed states a measurement, or it states nothing.

## 5. Approval names objects, not a report

The user approves exact identities and paths (`housekeeping_approval_not_exact`). Approving "the report" would extend to objects that appeared after it was written, which is precisely the window this contract exists to close.

While the report is being read, the world keeps moving. So every object is **revalidated immediately before its delete**: identity and every classification signal recomputed. Any change and the object is skipped and reported, not deleted (`housekeeping_stale_approval`). A task that started between the report and the approval finds its worktree still there.

## 6. Deleting is one object at a time, through the adapter

Never a raw `rm -rf` or `git worktree remove --force` from a model shell (`housekeeping_untrusted_delete`). Every deletion records the adapter and the operation that performed it.

A failure stops that object and not the run: the remaining objects are still processed, and the result is three exact lists — removed, failed and kept — each with its reason (`housekeeping_unrecoverable_failure` when a failure leaves state that cannot be resumed). After the deletes, the inventory is re-listed and revalidated, and the report describes the state that now exists rather than the state that was intended.

Running housekeeping twice over an unchanged host proposes nothing the second time. That is what makes it safe to run often, and it is a property of the classification being derived rather than accumulated.

## 7. Refusal classes

- `housekeeping_hidden_side_effect`;
- `housekeeping_in_use_proposed`;
- `housekeeping_unavailable_signal_treated_as_safe`;
- `housekeeping_age_as_proof`;
- `housekeeping_submodule_work_lost`;
- `housekeeping_size_unmeasured`;
- `housekeeping_ownership_unproven`;
- `housekeeping_approval_not_exact`;
- `housekeeping_stale_approval`;
- `housekeeping_untrusted_delete`;
- `housekeeping_unknown_deleted`;
- `housekeeping_unrecoverable_failure`.

## 8. What this contract decides, and what it defers

Decided: that housekeeping is a named command and not a side effect; the inventory's scope and per-object ownership proof; the seven classes and which three may be proposed; that classification is derived from three-state signals and that any unavailable signal forces `unknown`; that age never classifies; that submodule work blocks a green class; that size is measured; that approval names exact objects; that every object is revalidated immediately before its delete; that deletion goes through the trusted adapter one object at a time; and that the outcome is three exact lists.

Deferred and named: the inventory collector, the classifier implementation, the deletion driver and the CLI surface. Those are `required_for_v1` and are not claimed here.
