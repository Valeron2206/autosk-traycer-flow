from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def replace_once(relative, old, new, label):
    path = ROOT / relative
    text = path.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{relative}: expected one {label}, found {count}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


replace_once(
    "scripts/validate-tickets-manifest-design.mjs",
    '''    manifest.goal,
''',
    '''    oneLine(manifest.goal),
''',
    "README goal rendering",
)

replace_once(
    "scripts/validate-tickets-manifest-design.mjs",
    '''      ticket.goal,
''',
    '''      oneLine(ticket.goal),
''',
    "Ticket goal rendering",
)

replace_once(
    "test/validate-tickets-manifest-design.test.mjs",
    '''test("renderer prevents title and table-cell structure injection", () => {
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
    '''test("renderer prevents title, goal and table-cell structure injection", () => {
  const manifest = fixture();
  manifest.goal = "Manifest goal\\n## Forged manifest section";
  manifest.tickets[0].title = "Left | Right\\ncontinued";
  manifest.tickets[0].goal = "Ticket goal | second column\\n## Forged Ticket section";
  const first = renderTicketDocuments(manifest);
  const second = renderTicketDocuments(structuredClone(manifest));
  const overview = first.get(`docs/autosk/epics/${manifest.epic_id}/tickets/README.md`);
  const ticket = first.get(manifest.tickets[0].document_path);
  assert.deepEqual([...first], [...second]);
  assert.match(overview, /^Manifest goal ## Forged manifest section$/mu);
  assert.match(overview, /Ticket goal &#124; second column ## Forged Ticket section/u);
  assert.match(overview, /Left &#124; Right continued/u);
  assert.match(ticket, /^# T01 — Left \\| Right continued$/mu);
  assert.match(ticket, /^Ticket goal \\| second column ## Forged Ticket section$/mu);
  assert.doesNotMatch(overview, /^## Forged manifest section$/mu);
  assert.doesNotMatch(overview, /^## Forged Ticket section$/mu);
  assert.doesNotMatch(ticket, /^continued$/mu);
  assert.doesNotMatch(ticket, /^## Forged Ticket section$/mu);
});''',
    "renderer injection test",
)

print("Closed manifest and Ticket goal heading injection.")
