from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def replace_once(relative: str, old: str, new: str, label: str) -> None:
    path = ROOT / relative
    text = path.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{relative}: expected exactly one {label} fragment, found {count}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


replace_once(
    "01-core-flows.md",
    "                  -> Decision Record / changed Tech Plan -> new full panel -> publish planning commit\n",
    "                  -> Decision Record / changed Tech Plan -> new full panel\n"
    "                  -> record_artifact_pass -> publish_artifact_pass -> verified planning commit\n",
    "Arena publication path",
)

replace_once(
    "03-technical-plan.md",
    "  -> record_alignment -> draft_artifact\n"
    "  -> freeze_artifact -> dispatch_panel\n\n"
    "execution:\n",
    "  -> record_alignment -> draft_artifact\n"
    "  -> freeze_artifact -> dispatch_panel -> panel_join -> synthesize_panel\n"
    "  -> record_artifact_pass -> publish_artifact_pass\n\n"
    "execution:\n",
    "Arena state-machine path",
)

replace_once(
    "docs/contracts/epic-planning-ref.md",
    "| phase=`prepared|commit_created`, ref=expected commit and exactly one new matching reflog entry follows the checkpoint | reconstruct a successful CAS receipt only after exact commit verification; record `ref_advanced` |\n",
    "| phase=`prepared` or phase=`commit_created`, ref=expected commit and exactly one new matching reflog entry follows the checkpoint | reconstruct a successful CAS receipt only after exact commit verification; record `ref_advanced` |\n",
    "Markdown recovery table separator",
)

validator = ROOT / "scripts/validate-planning-ref-design.mjs"
text = validator.read_text(encoding="utf-8")
needle = '''export function validatePlanningRefDesign(files) {
'''
helper = r'''export function parseMarkdownTableRow(line) {
  if (typeof line !== "string" || !line.trimStart().startsWith("|")) return null;
  const cells = [];
  let cell = "";
  let codeDelimiterLength = 0;

  for (let index = 0; index < line.length;) {
    const character = line[index];
    if (character === "\\" && line[index + 1] === "|") {
      cell += "\\|";
      index += 2;
      continue;
    }
    if (character === "`") {
      let run = 1;
      while (line[index + run] === "`") run += 1;
      const delimiter = "`".repeat(run);
      if (codeDelimiterLength === 0) codeDelimiterLength = run;
      else if (codeDelimiterLength === run) codeDelimiterLength = 0;
      cell += delimiter;
      index += run;
      continue;
    }
    if (character === "|" && codeDelimiterLength === 0) {
      cells.push(cell.trim());
      cell = "";
      index += 1;
      continue;
    }
    cell += character;
    index += 1;
  }
  cells.push(cell.trim());
  if (cells[0] === "") cells.shift();
  if (cells.at(-1) === "") cells.pop();
  return cells;
}

export function parseCanonicalTransitionRows(markdown) {
  const rows = [];
  for (const [lineIndex, line] of String(markdown ?? "").split(/\r?\n/u).entries()) {
    const cells = parseMarkdownTableRow(line);
    if (!cells || cells.length !== 3) continue;
    const [step, condition, action] = cells;
    if (step === "Текущий шаг" || /^-+$/u.test(step)) continue;
    rows.push({ step, condition, action, line: lineIndex + 1 });
  }
  return rows;
}

'''
if text.count(needle) != 1:
    raise SystemExit(f"validator: expected one validate function marker, found {text.count(needle)}")
text = text.replace(needle, helper + needle, 1)

old = '''  const plan = files["03-technical-plan.md"] ?? "";
  const forbidden = [
    "record_artifact_pass | disposition=waived и signed panel waiver mode=full_skip exact current identity валиден | validate/merge Arena fields identically to pass; atomically artifact_pass[kind]={disposition:waived,identity,waiver_record_id,waiver_record_hash}; if kind=tickets and remediation phase=proposal_ready, verify new set digest and set phase=closed; select_next",
    "record_artifact_pass | disposition=pass, verdict binding текущей identity валиден; для tech_plan Arena block валиден | atomically artifact_pass[kind]={disposition:pass,identity,verdict_hash}, arena fields обновлены; if kind=tickets and remediation phase=proposal_ready, verify new set digest and set phase=closed; select_next",
  ];
  for (const fragment of forbidden) {
    if (plan.includes(fragment)) errors.push("03-technical-plan.md: direct record_artifact_pass → select_next transition remains");
  }
'''
new = r'''  const plan = files["03-technical-plan.md"] ?? "";
  const transitionRows = parseCanonicalTransitionRows(plan);
  const recordPassRows = transitionRows.filter((row) => row.step.replaceAll("`", "").trim() === "record_artifact_pass");
  if (recordPassRows.length === 0) {
    errors.push("03-technical-plan.md: canonical transition table has no record_artifact_pass rows");
  }
  let successfulPublicationRows = 0;
  for (const row of recordPassRows) {
    const action = row.action.replaceAll("`", "");
    if (/\bselect_next\b/u.test(action)) {
      errors.push(`03-technical-plan.md:${row.line}: record_artifact_pass must not transition directly to select_next`);
    }
    const dispositionPredicate = /disposition\s*=\s*(?:pass|waived)/u.test(row.condition.replaceAll("`", ""));
    const failureAction = /(?:\bhuman\b|ничего не записано)/iu.test(action);
    if (dispositionPredicate && !failureAction) {
      if (!/\bpublish_artifact_pass\b/u.test(action)) {
        errors.push(`03-technical-plan.md:${row.line}: successful record_artifact_pass must transition to publish_artifact_pass`);
      } else {
        successfulPublicationRows += 1;
      }
    }
  }
  if (successfulPublicationRows === 0) {
    errors.push("03-technical-plan.md: no successful record_artifact_pass publication route found");
  }

  if (!plan.includes("apply_arena_decision -> clarify_alignment") ||
      !plan.includes("dispatch_panel -> panel_join -> synthesize_panel") ||
      !plan.includes("record_artifact_pass -> publish_artifact_pass")) {
    errors.push("03-technical-plan.md: Arena re-expression path must pass through record_artifact_pass and publish_artifact_pass");
  }
'''
if text.count(old) != 1:
    raise SystemExit(f"validator: expected one legacy forbidden-block, found {text.count(old)}")
text = text.replace(old, new, 1)

old = '''  const core = files["01-core-flows.md"] ?? "";
  if (!core.includes("recorded PASS не является завершённым артефактом")) {
    errors.push("01-core-flows.md: recorded-vs-published PASS distinction missing");
  }
'''
new = '''  const core = files["01-core-flows.md"] ?? "";
  if (!core.includes("recorded PASS не является завершённым артефактом")) {
    errors.push("01-core-flows.md: recorded-vs-published PASS distinction missing");
  }
  if (!core.includes("Decision Record / changed Tech Plan -> new full panel\\n                  -> record_artifact_pass -> publish_artifact_pass -> verified planning commit")) {
    errors.push("01-core-flows.md: Arena changed-Tech-Plan path bypasses recorded then published PASS");
  }
'''
if text.count(old) != 1:
    raise SystemExit(f"validator: expected one core PASS block, found {text.count(old)}")
text = text.replace(old, new, 1)

old = '''  if (!contract.includes("`voided_before_ref` is the only unsuccessful terminal phase")) {
    errors.push("planning publication pre-CAS drift must have a terminal void phase");
  }
'''
new = '''  if (!contract.includes("`voided_before_ref` is the only unsuccessful terminal phase")) {
    errors.push("planning publication pre-CAS drift must have a terminal void phase");
  }
  if (contract.includes("phase=`prepared|commit_created`")) {
    errors.push("docs/contracts/epic-planning-ref.md: unescaped Markdown table separator in phase alternatives");
  }
'''
if text.count(old) != 1:
    raise SystemExit(f"validator: expected one terminal-void block, found {text.count(old)}")
text = text.replace(old, new, 1)
validator.write_text(text, encoding="utf-8")

# Extend adversarial tests.
test_path = ROOT / "test/validate-planning-ref-design.test.mjs"
tests = test_path.read_text(encoding="utf-8")
old_import = '''  loadPlanningRefFiles,
  planningRefDesignDigest,
  validatePlanningRefDesign,
'''
new_import = '''  loadPlanningRefFiles,
  parseCanonicalTransitionRows,
  planningRefDesignDigest,
  validatePlanningRefDesign,
'''
if tests.count(old_import) != 1:
    raise SystemExit(f"tests: expected one import block, found {tests.count(old_import)}")
tests = tests.replace(old_import, new_import, 1)

append = r'''

test("semantic transition parsing rejects reworded direct progression", () => {
  const files = fixture();
  files["03-technical-plan.md"] += [
    "",
    "| record_artifact_pass | renamed successful predicate | persist a final verdict and select_next |",
  ].join("\n");
  assert.match(validatePlanningRefDesign(files).join("\n"), /must not transition directly to select_next/u);
});

test("successful disposition cannot omit publication under altered action wording", () => {
  const files = fixture();
  files["03-technical-plan.md"] = files["03-technical-plan.md"].replace(
    "create immutable planning_publication_op phase=prepared with exact recipe/OID; publish_artifact_pass",
    "store a valid disposition without its publication transition",
  );
  assert.match(validatePlanningRefDesign(files).join("\n"), /must transition to publish_artifact_pass/u);
});

test("transition parser preserves inline-code pipes and escaped pipes", () => {
  const rows = parseCanonicalTransitionRows([
    "| Текущий шаг | Условие | Следующий шаг |",
    "| --- | --- | --- |",
    "| record_artifact_pass | source=`pass|waived` and literal \\| marker | publish_artifact_pass |",
  ].join("\n"));
  assert.deepEqual(rows, [{
    step: "record_artifact_pass",
    condition: "source=`pass|waived` and literal \\| marker",
    action: "publish_artifact_pass",
    line: 3,
  }]);
});

test("Arena re-expression must use recorded then published PASS", () => {
  const files = fixture();
  files["01-core-flows.md"] = files["01-core-flows.md"].replace(
    "-> record_artifact_pass -> publish_artifact_pass -> verified planning commit",
    "-> direct planning commit",
  );
  files["03-technical-plan.md"] = files["03-technical-plan.md"].replace(
    "-> freeze_artifact -> dispatch_panel -> panel_join -> synthesize_panel\n  -> record_artifact_pass -> publish_artifact_pass",
    "-> freeze_artifact -> dispatch_panel",
  );
  const result = validatePlanningRefDesign(files).join("\n");
  assert.match(result, /Arena changed-Tech-Plan path/u);
  assert.match(result, /Arena re-expression path/u);
});

test("normative recovery table forbids an unescaped phase pipe", () => {
  const files = fixture();
  files["docs/contracts/epic-planning-ref.md"] = files["docs/contracts/epic-planning-ref.md"].replace(
    "phase=`prepared` or phase=`commit_created`",
    "phase=`prepared|commit_created`",
  );
  assert.match(validatePlanningRefDesign(files).join("\n"), /unescaped Markdown table separator/u);
});
'''
if "semantic transition parsing rejects reworded direct progression" in tests:
    raise SystemExit("tests: semantic transition tests already present")
test_path.write_text(tests + append, encoding="utf-8")

print("Applied all confirmed CodeRabbit fixes for issue #5.")
