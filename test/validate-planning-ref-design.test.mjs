import assert from "node:assert/strict";
import test from "node:test";

import {
  loadPlanningRefFiles,
  planningRefDesignDigest,
  validatePlanningRefDesign,
} from "../scripts/validate-planning-ref-design.mjs";

function fixture() {
  return structuredClone(loadPlanningRefFiles());
}

test("current planning-ref design contract is internally connected", () => {
  const files = fixture();
  assert.deepEqual(validatePlanningRefDesign(files), []);
  assert.match(planningRefDesignDigest(files), /^[0-9a-f]{64}$/u);
});

test("missing cross-document contract markers fail closed", () => {
  const files = fixture();
  files["03-technical-plan.md"] = files["03-technical-plan.md"].replaceAll("planning_publication_op", "removed_operation");
  assert.match(validatePlanningRefDesign(files).join("\n"), /planning_publication_op/u);
});

test("direct record-artifact-pass to select-next regression is rejected", () => {
  const files = fixture();
  files["03-technical-plan.md"] += "\n| record_artifact_pass | disposition=pass, verdict binding текущей identity валиден; для tech_plan Arena block валиден | atomically artifact_pass[kind]={disposition:pass,identity,verdict_hash}, arena fields обновлены; if kind=tickets and remediation phase=proposal_ready, verify new set digest and set phase=closed; select_next |\n";
  assert.match(validatePlanningRefDesign(files).join("\n"), /direct record_artifact_pass/u);
});

test("publication phase documentation is monotonic", () => {
  const files = fixture();
  files["docs/contracts/epic-planning-ref.md"] = files["docs/contracts/epic-planning-ref.md"].replace(
    "prepared\n→ commit_created\n→ ref_advanced\n→ verified",
    "verified\n→ ref_advanced\n→ commit_created\n→ prepared",
  );
  assert.match(validatePlanningRefDesign(files).join("\n"), /monotonic order/u);
});

test("recorded and published PASS distinction is required", () => {
  const files = fixture();
  files["01-core-flows.md"] = files["01-core-flows.md"].replace(
    "recorded PASS не является завершённым артефактом",
    "PASS distinction removed",
  );
  assert.match(validatePlanningRefDesign(files).join("\n"), /recorded-vs-published/u);
});
