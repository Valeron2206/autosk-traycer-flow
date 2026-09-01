from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def replace_once(path: Path, old: str, new: str, label: str) -> None:
    text = path.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected exactly one {label} fragment, found {count}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


validator = ROOT / "scripts/validate-planning-ref-design.mjs"
replace_once(
    validator,
    '''  const contract = files["docs/contracts/epic-planning-ref.md"] ?? "";
  const phaseOrder = ["prepared", "commit_created", "ref_advanced", "verified"];
  let previous = -1;
  for (const phase of phaseOrder) {
    const current = contract.indexOf(phase);
    if (current < 0 || current <= previous) errors.push("planning publication phases are missing or not documented in monotonic order");
    previous = current;
  }
''',
    '''  const contract = files["docs/contracts/epic-planning-ref.md"] ?? "";
  const canonicalPhaseSequence = "prepared\\n→ commit_created\\n→ ref_advanced\\n→ verified";
  if (!contract.includes(canonicalPhaseSequence)) {
    errors.push("planning publication phases are missing or not documented in monotonic order");
  }
''',
    "phase-sequence validation",
)

test_path = ROOT / "test/validate-planning-ref-design.test.mjs"
replace_once(
    test_path,
    '''  files["03-technical-plan.md"] = files["03-technical-plan.md"].replace("planning_publication_op", "removed_operation");
''',
    '''  files["03-technical-plan.md"] = files["03-technical-plan.md"].replaceAll("planning_publication_op", "removed_operation");
''',
    "missing-marker mutation",
)

print("Corrected planning-ref validator tests.")
