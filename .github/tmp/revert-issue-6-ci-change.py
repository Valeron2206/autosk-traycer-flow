from __future__ import annotations

from pathlib import Path

path = Path(__file__).resolve().parents[2] / ".github/workflows/validate-traycer-parity.yml"
text = path.read_text(encoding="utf-8")
old = """      - name: Validate Epic planning-ref design contract
        run: npm run validate:planning-ref

      - name: Validate canonical Tickets manifest design contract
        run: npm run validate:tickets-manifest

      - name: Validate pull-request file scope
"""
new = """      - name: Validate Epic planning-ref design contract
        run: npm run validate:planning-ref

      - name: Validate pull-request file scope
"""
if text.count(old) != 1:
    raise SystemExit(f"expected one staged Tickets CI block, found {text.count(old)}")
path.write_text(text.replace(old, new, 1), encoding="utf-8")
print("Deferred persistent workflow update to a connector-authorized commit.")
