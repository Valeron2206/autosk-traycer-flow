#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const CONTRACT_FILES = Object.freeze([
  "README.md",
  "01-core-flows.md",
  "02-architecture.md",
  "03-technical-plan.md",
  "04-decisions.md",
  "CONTRIBUTING.md",
  "docs/contracts/epic-planning-ref.md",
]);

const REQUIRED = Object.freeze({
  "README.md": [
    "docs/contracts/epic-planning-ref.md",
    "publish_artifact_pass",
    "refs/autosk/epics/<epic-uuid>/planning",
  ],
  "01-core-flows.md": [
    "<!-- planning-ref-contract:v1 -->",
    "record_artifact_pass",
    "publish_artifact_pass",
    "planning_ref_foreign_movement",
    "verified planning_head",
  ],
  "02-architecture.md": [
    "<!-- planning-ref-contract:v1 -->",
    "Planning publication adapter",
    "refs/autosk/epics/<epic-uuid>/planning",
    "planning_publication_op",
  ],
  "03-technical-plan.md": [
    "<!-- planning-ref-contract:v1 -->",
    "init_planning_ref",
    "publish_artifact_pass",
    "publish_planning_invalidation",
    "planning_publication_op",
    "recorded_unpublished",
    "planning_candidate_base_stale",
    "planning_ref_foreign_movement",
    "planning_publication_corrupt",
  ],
  "04-decisions.md": [
    "ADR-026: private Epic planning ref и commit-on-PASS",
    "refs/autosk/epics/<epic-uuid>/planning",
    "publish_artifact_pass",
  ],
  "CONTRIBUTING.md": [
    "docs/contracts/epic-planning-ref.md",
    "npm run validate:planning-ref",
  ],
  "docs/contracts/epic-planning-ref.md": [
    "<!-- planning-ref-contract:v1 -->",
    "prepared",
    "commit_created",
    "ref_advanced",
    "verified",
    "planning_ref_foreign_movement",
    "planning_publication_corrupt",
    "Issue #6",
    "Issue #7",
    "Issue #8",
    "Issue #9",
  ],
});

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function loadPlanningRefFiles(root = ROOT) {
  return Object.fromEntries(
    CONTRACT_FILES.map((relative) => [
      relative,
      readFileSync(path.join(root, relative), "utf8"),
    ]),
  );
}

export function validatePlanningRefDesign(files) {
  const errors = [];
  for (const relative of CONTRACT_FILES) {
    const text = files[relative];
    if (typeof text !== "string") {
      errors.push(`${relative}: missing`);
      continue;
    }
    for (const fragment of REQUIRED[relative]) {
      if (!text.includes(fragment)) errors.push(`${relative}: missing required fragment ${JSON.stringify(fragment)}`);
    }
  }

  const plan = files["03-technical-plan.md"] ?? "";
  const forbidden = [
    "record_artifact_pass | disposition=waived и signed panel waiver mode=full_skip exact current identity валиден | validate/merge Arena fields identically to pass; atomically artifact_pass[kind]={disposition:waived,identity,waiver_record_id,waiver_record_hash}; if kind=tickets and remediation phase=proposal_ready, verify new set digest and set phase=closed; select_next",
    "record_artifact_pass | disposition=pass, verdict binding текущей identity валиден; для tech_plan Arena block валиден | atomically artifact_pass[kind]={disposition:pass,identity,verdict_hash}, arena fields обновлены; if kind=tickets and remediation phase=proposal_ready, verify new set digest and set phase=closed; select_next",
  ];
  for (const fragment of forbidden) {
    if (plan.includes(fragment)) errors.push("03-technical-plan.md: direct record_artifact_pass → select_next transition remains");
  }

  const core = files["01-core-flows.md"] ?? "";
  if (!core.includes("recorded PASS не является завершённым артефактом")) {
    errors.push("01-core-flows.md: recorded-vs-published PASS distinction missing");
  }

  const contract = files["docs/contracts/epic-planning-ref.md"] ?? "";
  const canonicalPhaseSequence = "prepared\n→ commit_created\n→ ref_advanced\n→ verified";
  if (!contract.includes(canonicalPhaseSequence)) {
    errors.push("planning publication phases are missing or not documented in monotonic order");
  }

  return errors;
}

export function planningRefDesignDigest(files) {
  const payload = CONTRACT_FILES.map((relative) => `${relative}\0${sha256(files[relative] ?? "")}`).join("\0");
  return sha256(`autosk-flow/planning-ref-design/v1\0${payload}`);
}

function run() {
  const files = loadPlanningRefFiles();
  const errors = validatePlanningRefDesign(files);
  if (errors.length) {
    for (const error of errors) console.error(`ERROR: ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`OK: planning-ref design contract v1; digest ${planningRefDesignDigest(files)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run();
