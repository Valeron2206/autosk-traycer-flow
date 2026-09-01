from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
path = ROOT / "03-technical-plan.md"
text = path.read_text(encoding="utf-8")
old = "`planning_ref_init_op` имеет phases `prepared -> ref_created -> verified` и требует operation-specific reflog proof before adopting a ref already at base. `planning_publication_op` имеет typed payload=`artifact_pass|anchor_invalidation`, full persisted/read-back exact commit recipe and object bytes, phases `prepared -> commit_created -> ref_advanced -> verified`, terminal `voided_before_ref`, exact expected parent/tree/commit, reflog checkpoint and monotonic receipts. Ref at expected commit after crash is accepted only after full object+reflog verification; changed prefix/ABA/other movement parks `planning_ref_foreign_movement`. Missing/corrupt claimed durable state parks `planning_publication_corrupt`. No re-sign/recompute-from-latest, rebase/reset/force/cherry-pick/adopt-current recovery exists."
new = "`planning_ref_init_op` имеет phases `prepared -> ref_created -> verified` и требует operation-specific reflog proof before adopting a ref already at base. `planning_publication_op` имеет typed payload=`artifact_pass|anchor_invalidation`, full persisted/read-back exact commit recipe including `commit_object_bytes_base64`, phases `prepared -> commit_created -> ref_advanced -> verified`, terminal `voided_before_ref`, exact expected parent/tree/commit, `reflog_checkpoint` and monotonic receipts. Ref at expected commit after crash is accepted only after full object+reflog verification; changed prefix/ABA/other movement parks `planning_ref_foreign_movement`. Missing/corrupt claimed durable state parks `planning_publication_corrupt`. No re-sign/recompute-from-latest, rebase/reset/force/cherry-pick/adopt-current recovery exists."
if text.count(old) != 1:
    raise SystemExit(f"expected one hardened planning summary, found {text.count(old)}")
path.write_text(text.replace(old, new, 1), encoding="utf-8")
print("Added exact recovery field names to the technical-plan summary.")
