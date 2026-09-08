#!/usr/bin/env node

/**
 * Design-time validator for the issue #47 static-analysis gate.
 *
 * A deterministic analyzer is cheap to trust wrongly: the tree changes, the
 * analysis id does not, and a green check from twenty minutes ago is still on
 * the page. So the checks here are about identity, about which conditions were
 * actually evaluated, and about the states a run may not quietly slide between.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateJsonSchema } from "./validate-planning-ref-design.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CONTRACT_PATH = "docs/contracts/static-analysis.md";
export const POLICY_SCHEMA_PATH = "resources/static-analysis/static-analysis-policy.schema.json";
export const RESULT_SCHEMA_PATH = "resources/static-analysis/static-analysis-result.schema.json";
export const POLICY_EXAMPLE_PATH = "resources/static-analysis/static-analysis-policy.example.json";
export const RESULT_EXAMPLE_PATH = "resources/static-analysis/static-analysis-result.example.json";
export const REFUSED_EXAMPLE_PATH = "resources/static-analysis/static-analysis-result.refused.example.json";
export const CONTRACT_MARKER = "<!-- static-analysis-contract:v1 -->";

/** The seven conditions of `Sonar way for AI Code`, and which four a PR applies. */
export const CONDITIONS = Object.freeze([
  { id: "no-new-issues", scope: "new_code", pull_request: true },
  { id: "new-hotspots-reviewed", scope: "new_code", pull_request: true },
  { id: "new-coverage", scope: "new_code", pull_request: true },
  { id: "new-duplication", scope: "new_code", pull_request: true },
  { id: "security-rating", scope: "overall_code", pull_request: false },
  { id: "hotspots-reviewed", scope: "overall_code", pull_request: false },
  { id: "reliability-rating", scope: "overall_code", pull_request: false },
]);

export const ENFORCEMENT = Object.freeze(["disabled", "advisory", "required"]);

/** Findings the implementer may not dispose of. */
export const IMPLEMENTER_FORBIDDEN = Object.freeze(["security_hotspot", "issue"]);

export const REFUSALS = Object.freeze([
  "sonar_gate_replaces_review",
  "sonar_provider_hardcoded",
  "sonar_silent_downgrade",
  "sonar_pass_without_analysis",
  "sonar_policy_not_exact",
  "sonar_mode_mismatch",
  "sonar_small_change_bypass",
  "sonar_identity_stale",
  "sonar_report_provenance_missing",
  "sonar_disposition_by_implementer",
  "sonar_webhook_unauthenticated",
  "sonar_webhook_foreign",
  "sonar_webhook_replay",
  "sonar_result_without_receipt",
  "sonar_delivery_undecided",
]);

export function loadFiles() {
  const files = {};
  for (const relative of [
    CONTRACT_PATH,
    POLICY_SCHEMA_PATH,
    RESULT_SCHEMA_PATH,
    POLICY_EXAMPLE_PATH,
    RESULT_EXAMPLE_PATH,
    REFUSED_EXAMPLE_PATH,
  ]) {
    files[relative] = readFileSync(path.join(ROOT, relative), "utf8");
  }
  return files;
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function staticAnalysisDesignDigest(files) {
  return sha256(
    Object.keys(files)
      .sort()
      .map((relative) => `${relative} ${sha256(files[relative])}`)
      .join(""),
  );
}

export function policyDigest(policy) {
  const { digest, ...body } = policy;
  return sha256(canonical(body));
}

/** The condition ids a mode is supposed to evaluate. */
export function expectedConditions(mode) {
  if (mode === "pull_request") return CONDITIONS.filter((entry) => entry.pull_request).map((entry) => entry.id);
  if (mode === "main_branch") return CONDITIONS.map((entry) => entry.id);
  return [];
}

export function validatePolicy(policy, schema) {
  const errors = validateJsonSchema(policy, schema).map((message) => `schema: ${message}`);
  if (errors.length > 0) return errors;

  const declared = policy.conditions.map((entry) => entry.id);
  const expected = CONDITIONS.map((entry) => entry.id);
  if (declared.slice().sort().join(",") !== expected.slice().sort().join(",")) {
    errors.push(`sonar_policy_not_exact: the seven conditions are ${declared.join(", ")}`);
  }
  for (const condition of CONDITIONS) {
    const found = policy.conditions.find((entry) => entry.id === condition.id);
    if (!found) continue;
    if (found.scope !== condition.scope) {
      errors.push(`sonar_policy_not_exact: ${condition.id} is ${found.scope}, not ${condition.scope}`);
    }
    if (found.applies_to_pull_request !== condition.pull_request) {
      errors.push(`sonar_mode_mismatch: ${condition.id} pull-request applicability is wrong`);
    }
  }
  if (policy.small_change.provider_fudge_factor !== "disabled" && !policy.small_change.host_compensates) {
    // A stream of small agent edits would otherwise pass a coverage
    // requirement none of them met.
    errors.push("sonar_small_change_bypass: the provider fudge factor is on and the host does not compensate");
  }
  if (policy.delivery.hosted && !policy.delivery.decision_ref) {
    errors.push("sonar_delivery_undecided: sending code to a hosted analyzer is a recorded delivery decision");
  }
  if (policy.digest !== policyDigest(policy)) {
    errors.push("sonar_identity_stale: the policy digest does not recompute");
  }
  return errors;
}

export function validateResult(result, policy, schema) {
  const errors = validateJsonSchema(result, schema).map((message) => `schema: ${message}`);
  if (errors.length > 0) return errors;

  if (result.replaces_review) {
    errors.push("sonar_gate_replaces_review: the analyzer is not a fifth model and replaces no review");
  }
  if (result.policy_digest !== policy.digest) {
    // A quality gate, profile or new-code definition changed mid-run.
    errors.push(`sonar_identity_stale: the result cites policy ${result.policy_digest}`);
  }
  if (result.candidate.current_tree_oid !== result.candidate.tree_oid) {
    // Where a stale PASS gets accepted in practice.
    errors.push(`sonar_identity_stale: analysed ${result.candidate.tree_oid}, current ${result.candidate.current_tree_oid}`);
  }

  const expected = expectedConditions(result.mode);
  const evaluated = result.conditions_evaluated.slice().sort().join(",");
  if (evaluated !== expected.slice().sort().join(",")) {
    // Computing the wrong set is not a stricter or looser gate; it is an answer
    // about a different question.
    errors.push(`sonar_mode_mismatch: ${result.mode} evaluated ${result.conditions_evaluated.length} conditions, expected ${expected.length}`);
  }
  if ((result.provider.unsupported_modes ?? []).includes(result.mode) && result.outcome === "pass") {
    errors.push(`sonar_pass_without_analysis: ${result.mode} is unsupported by this provider`);
  }
  if (result.analysis.state !== "success" && result.outcome === "pass") {
    errors.push(`sonar_pass_without_analysis: the analysis is ${result.analysis.state}`);
  }
  if (result.mode === "unavailable" && result.outcome === "pass") {
    errors.push("sonar_pass_without_analysis: the gate did not run");
  }
  if (policy.enforcement === "disabled" && result.outcome === "pass") {
    // A disabled gate does not claim a static-analysis PASS.
    errors.push("sonar_silent_downgrade: a disabled gate recorded a PASS");
  }
  if (policy.enforcement === "required" && result.outcome === "not_run") {
    // An unavailable required gate is not an advisory gate.
    errors.push("sonar_silent_downgrade: a required gate that did not run must block, not pass through");
  }

  for (const report of result.input_reports) {
    if (!report.producer) {
      // "Coverage 84%" is a number with no subject.
      errors.push(`sonar_report_provenance_missing: ${report.path} names no producer`);
    }
    if (report.produced_from_tree_oid !== result.candidate.tree_oid) {
      errors.push(`sonar_report_provenance_missing: ${report.path} was produced from another tree`);
    }
  }

  if (!result.analysis.receipt_recorded) {
    errors.push("sonar_result_without_receipt: a result arrived for an operation the host has not recorded");
  }
  if (result.webhook) {
    if (!result.webhook.authenticated) {
      errors.push("sonar_webhook_unauthenticated");
    }
    if (
      result.webhook.analysis_id !== result.analysis.analysis_id ||
      result.webhook.project_key !== result.analysis.project_key
    ) {
      errors.push(`sonar_webhook_foreign: ${result.webhook.project_key}/${result.webhook.analysis_id}`);
    }
    const deliveries = result.webhook.seen_delivery_ids.filter((id) => id === result.webhook.delivery_id);
    if (deliveries.length > 1) {
      errors.push(`sonar_webhook_replay: ${result.webhook.delivery_id} was applied more than once`);
    }
  }

  for (const finding of result.findings) {
    if (IMPLEMENTER_FORBIDDEN.includes(finding.kind) && finding.disposed_by === "implementer") {
      // The implementer has the strongest reason to believe its own code is
      // safe, and this is where that belief would be recorded as a fact.
      errors.push(`sonar_disposition_by_implementer: ${finding.finding_id}`);
    }
    if (finding.disposition !== "open" && !finding.triage_ref) {
      errors.push(`sonar_disposition_by_implementer: ${finding.finding_id} is disposed outside the canonical triage`);
    }
  }
  return errors;
}

export function validateStaticAnalysisDesign(files) {
  const errors = [];
  const contract = files[CONTRACT_PATH];
  if (!contract.includes(CONTRACT_MARKER)) errors.push(`${CONTRACT_PATH}: missing ${CONTRACT_MARKER}`);
  for (const relative of [POLICY_SCHEMA_PATH, RESULT_SCHEMA_PATH]) {
    if (!contract.includes(relative)) errors.push(`${CONTRACT_PATH}: does not point at ${relative}`);
  }
  for (const refusal of REFUSALS) {
    if (!contract.includes(refusal)) errors.push(`${CONTRACT_PATH}: refusal ${refusal} is not documented`);
  }
  if (!contract.includes("not a fifth model")) {
    errors.push(`${CONTRACT_PATH}: does not state what the analyzer is not`);
  }
  if (!contract.includes("absent, not approximated")) {
    errors.push(`${CONTRACT_PATH}: does not state what an unsupported capability is`);
  }
  if (!contract.includes("a gate that did not run")) {
    errors.push(`${CONTRACT_PATH}: does not state what an unavailable required gate is`);
  }
  if (!contract.includes("off by default")) {
    errors.push(`${CONTRACT_PATH}: does not state the small-change policy`);
  }
  if (!contract.includes("No account, plan or purchase is created by this contract")) {
    errors.push(`${CONTRACT_PATH}: does not state that it authorises no purchase`);
  }
  for (const state of ENFORCEMENT) {
    if (!contract.includes(`\`${state}\``)) {
      errors.push(`${CONTRACT_PATH}: enforcement state ${state} is not documented`);
    }
  }

  let policySchema;
  let resultSchema;
  try {
    policySchema = JSON.parse(files[POLICY_SCHEMA_PATH]);
    resultSchema = JSON.parse(files[RESULT_SCHEMA_PATH]);
  } catch (error) {
    return [...errors, `schemas: not valid JSON: ${error.message}`];
  }
  for (const [relative, schema] of [
    [POLICY_SCHEMA_PATH, policySchema],
    [RESULT_SCHEMA_PATH, resultSchema],
  ]) {
    if (schema.additionalProperties !== false) {
      errors.push(`${relative}: root must be closed (additionalProperties:false)`);
    }
  }
  const conditions = policySchema.properties?.conditions ?? {};
  if (conditions.minItems !== 7 || conditions.maxItems !== 7) {
    errors.push(`${POLICY_SCHEMA_PATH}: the policy is exactly seven conditions`);
  }
  if ((policySchema.properties?.enforcement?.enum ?? []).join(",") !== ENFORCEMENT.join(",")) {
    errors.push(`${POLICY_SCHEMA_PATH}: enforcement must be exactly disabled, advisory, required`);
  }
  if (resultSchema.properties?.replaces_review?.const !== false) {
    errors.push(`${RESULT_SCHEMA_PATH}: a result must not be able to claim it replaces a review`);
  }
  const providerRequired = resultSchema.properties?.provider?.required ?? [];
  for (const field of ["server_identity", "scanner_identity", "analyzers"]) {
    if (!providerRequired.includes(field)) {
      errors.push(`${RESULT_SCHEMA_PATH}: the provider identity must include ${field}`);
    }
  }
  const reportRequired = resultSchema.properties?.input_reports?.items?.required ?? [];
  for (const field of ["sha256", "produced_from_tree_oid"]) {
    if (!reportRequired.includes(field)) {
      errors.push(`${RESULT_SCHEMA_PATH}: an input report must carry ${field}`);
    }
  }
  // Provider-neutral by construction: nothing names a cloud, a plan or an
  // edition in either schema.
  const schemaText = `${files[POLICY_SCHEMA_PATH]}${files[RESULT_SCHEMA_PATH]}`.toLowerCase();
  for (const word of ["sonarcloud", "sonarqube", "free_plan", "enterprise", "developer_edition"]) {
    if (schemaText.includes(word)) {
      errors.push(`${RESULT_SCHEMA_PATH}: the interface names ${word}, so it is not provider-neutral`);
    }
  }

  let policy;
  try {
    policy = JSON.parse(files[POLICY_EXAMPLE_PATH]);
  } catch (error) {
    return [...errors, `${POLICY_EXAMPLE_PATH}: not valid JSON: ${error.message}`];
  }
  errors.push(...validatePolicy(policy, policySchema).map((message) => `${POLICY_EXAMPLE_PATH}: ${message}`));

  for (const relative of [RESULT_EXAMPLE_PATH, REFUSED_EXAMPLE_PATH]) {
    let result;
    try {
      result = JSON.parse(files[relative]);
    } catch (error) {
      errors.push(`${relative}: not valid JSON: ${error.message}`);
      continue;
    }
    const found = validateResult(result, policy, resultSchema);
    if (relative === RESULT_EXAMPLE_PATH) {
      errors.push(...found.map((message) => `${relative}: ${message}`));
    } else if (found.length === 0) {
      errors.push(`${relative}: the refused example is accepted`);
    }
  }
  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = loadFiles();
  const errors = validateStaticAnalysisDesign(files);
  if (errors.length > 0) {
    console.error(errors.sort().join("\n"));
    process.exitCode = 1;
  } else {
    const policy = JSON.parse(files[POLICY_EXAMPLE_PATH]);
    const resultSchema = JSON.parse(files[RESULT_SCHEMA_PATH]);
    const refused = validateResult(JSON.parse(files[REFUSED_EXAMPLE_PATH]), policy, resultSchema);
    console.log("Static analysis gate design validation PASS");
    console.log(`design_digest=${staticAnalysisDesignDigest(files)}`);
    console.log(`conditions=${CONDITIONS.length} pull_request=${expectedConditions("pull_request").length} refusals=${REFUSALS.length} refused_example_findings=${refused.length}`);
  }
}
