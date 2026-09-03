from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def replace_once(relative: str, old: str, new: str, label: str) -> None:
    path = ROOT / relative
    text = path.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{relative}: expected exactly one {label} marker, found {count}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


replace_once(
    "docs/contracts/tickets-manifest.md",
    "Issue #5 publishes the artifact and supplies `planning_head`. Issue #7 composes execution bases. Issue #8 owns approved deltas, #9 staging/final CAS, #23 verification recipes, #24 work-type/evidence contracts and #25 semantic revision decisions.",
    "Issue #5 publishes the artifact and supplies `planning_head`. Issue #7 composes execution bases. Issue #8 owns approved deltas. Issue #9 owns staging/final CAS. Issue #23 owns verification recipes, issue #24 work-type/evidence contracts and issue #25 semantic revision decisions.",
    "explicit downstream issue names",
)

replace_once(
    "scripts/validate-tickets-manifest-design.mjs",
    "  const tech = files[\"03-technical-plan.md\"] ?? \"\";\n  if (/dispatch_ticket_dag[^\\n|]*parse[^\\n|]*Markdown/iu.test(tech)) errors.push(\"03-technical-plan.md: dispatcher must not parse operational fields from Markdown\");\n",
    "  const tech = files[\"03-technical-plan.md\"] ?? \"\";\n  if (!tech.includes(\"it never parses rendered Markdown for operational values\")) {\n    errors.push(\"03-technical-plan.md: manifest-only dispatcher prohibition is missing\");\n  }\n",
    "manifest-only dispatcher validator",
)

print("Corrected issue #6 validator false positives without weakening the contract.")
