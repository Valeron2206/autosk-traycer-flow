#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def replace_once(relative: str, old: str, new: str, label: str) -> None:
    path = ROOT / relative
    text = path.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{relative}: expected one {label} fragment, found {count}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


replace_once(
    "scripts/validate-tickets-manifest-design.mjs",
    '''    manifest.goal,''',
    '''    oneLine(manifest.goal),''',
    "manifest goal rendering",
)
replace_once(
    "scripts/validate-tickets-manifest-design.mjs",
    '''      ticket.goal,''',
    '''      oneLine(ticket.goal),''',
    "Ticket goal rendering",
)

replace_once(
    "test/validate-tickets-manifest-design.test.mjs",
    '''test("renderer prevents heading and table-cell structure injection", () => {
  const manifest = fixture();
  manifest.tickets[0].title = "Left | Right\\ncontinued";
  manifest.tickets[0].goal = "Goal | second column";
  const documents = renderTicketDocuments(manifest);
  const overview = documents.get(`docs/autosk/epics/${manifest.epic_id}/tickets/README.md`);
  const ticket = documents.get(manifest.tickets[0].document_path);
  assert.match(overview, /Left &#124; Right continued/u);
  assert.match(overview, /Goal &#124; second column/u);
  assert.match(ticket, /^# T01 — Left \\| Right continued$/mu);
  assert.doesNotMatch(ticket, /^continued$/mu);
});''',
    '''test("renderer prevents heading and table-cell structure injection", () => {
  const manifest = fixture();
  manifest.goal = "Project goal.\\n## Forged overview heading";
  manifest.tickets[0].title = "Left | Right\\ncontinued";
  manifest.tickets[0].goal = "Goal | second column\\n## Forged Ticket heading";
  const documents = renderTicketDocuments(manifest);
  const overview = documents.get(`docs/autosk/epics/${manifest.epic_id}/tickets/README.md`);
  const ticket = documents.get(manifest.tickets[0].document_path);
  assert.match(overview, /Project goal\. ## Forged overview heading/u);
  assert.match(overview, /Left &#124; Right continued/u);
  assert.match(overview, /Goal &#124; second column ## Forged Ticket heading/u);
  assert.match(ticket, /^# T01 — Left \\| Right continued$/mu);
  assert.match(ticket, /^Goal \\| second column ## Forged Ticket heading$/mu);
  assert.doesNotMatch(overview, /^## Forged overview heading$/mu);
  assert.doesNotMatch(ticket, /^## Forged Ticket heading$/mu);
  assert.doesNotMatch(ticket, /^continued$/mu);
});''',
    "renderer injection regression test",
)

replace_once(
    "docs/contracts/tickets-manifest.md",
    '''The renderer normalizes headings to one line and escapes Markdown table delimiters so manifest text cannot forge overview rows or columns.''',
    '''The renderer normalizes headings and free-text body insertions to one line and escapes Markdown table delimiters so manifest text cannot forge headings, overview rows or columns.''',
    "renderer normalization contract",
)
replace_once(
    "02-architecture.md",
    '''byte-identical injection-safe renderer output.''',
    '''byte-identical injection-safe renderer output whose headings and free-text body insertions are one-line normalized.''',
    "architecture renderer normalization",
)
replace_once(
    "03-technical-plan.md",
    '''rendered path/bytes/structure drift,''',
    '''rendered path/bytes/structure drift or multiline goal injection,''',
    "state-machine goal injection guard",
)

print("Normalized manifest.goal and ticket.goal before Markdown body insertion and added exact regressions.")
