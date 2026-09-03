#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
path = ROOT / "scripts/validate-tickets-manifest-design.mjs"
text = path.read_text()
old = '''  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (cause) {
    return { manifest: null, text: null, errors: [error("tickets_manifest_noncanonical", "", "manifest is not valid UTF-8", { cause: String(cause) })] };
  }
  if (text.startsWith("\\uFEFF")) errors.push(error("tickets_manifest_noncanonical", "", "UTF-8 BOM is forbidden"));
'''
new = '''  const hasUtf8Bom = bytes.byteLength >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (cause) {
    return { manifest: null, text: null, errors: [error("tickets_manifest_noncanonical", "", "manifest is not valid UTF-8", { cause: String(cause) })] };
  }
  if (hasUtf8Bom || text.startsWith("\\uFEFF")) errors.push(error("tickets_manifest_noncanonical", "", "UTF-8 BOM is forbidden"));
'''
if text.count(old) != 1:
    raise SystemExit(f"expected one parser block, found {text.count(old)}")
path.write_text(text.replace(old, new, 1))
print("Added raw-byte UTF-8 BOM detection.")
