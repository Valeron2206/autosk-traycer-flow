#!/usr/bin/env node

/**
 * Design-time validator for the issue #30 Housekeeping workflow.
 *
 * Deleting is the one operation that cannot be reviewed afterwards. The checks
 * here are about the three ways a safe-looking cleanup removes live work: a
 * signal that could not be read treated as a signal that said no, age standing
 * in for proof, and an approval that covers a report rather than objects.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateJsonSchema } from "./validate-planning-ref-design.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CONTRACT_PATH = "docs/contracts/housekeeping.md";
export const SCHEMA_PATH = "resources/housekeeping/housekeeping-report.schema.json";
export const EXAMPLE_PATH = "resources/housekeeping/housekeeping-report.example.json";
export const REFUSED_EXAMPLE_PATH = "resources/housekeeping/housekeeping-report.refused.example.json";
export const CONTRACT_MARKER = "<!-- housekeeping-contract:v1 -->";

/** The three classes an ordinary report may propose. */
export const GREEN = Object.freeze(["landed", "at_base", "unreferenced"]);

/** The three that are confirmed one at a time, by exact identity and path. */
export const CONFIRM_SEPARATELY = Object.freeze(["review", "orphaned", "unknown"]);

export const CLASSES = Object.freeze(["in_use", ...GREEN, ...CONFIRM_SEPARATELY]);

/** Signals that, when present, mean the object is doing something. */
export const IN_USE_SIGNALS = Object.freeze(["active_reference", "held_lock", "open_or_unmerged_pr"]);

export const REFUSALS = Object.freeze([
  "housekeeping_hidden_side_effect",
  "housekeeping_in_use_proposed",
  "housekeeping_unavailable_signal_treated_as_safe",
  "housekeeping_age_as_proof",
  "housekeeping_submodule_work_lost",
  "housekeeping_size_unmeasured",
  "housekeeping_ownership_unproven",
  "housekeeping_approval_not_exact",
  "housekeeping_stale_approval",
  "housekeeping_untrusted_delete",
  "housekeeping_unknown_deleted",
  "housekeeping_unrecoverable_failure",
]);

export function loadFiles() {
  const files = {};
  for (const relative of [CONTRACT_PATH, SCHEMA_PATH, EXAMPLE_PATH, REFUSED_EXAMPLE_PATH]) {
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

export function housekeepingDesignDigest(files) {
  return sha256(
    Object.keys(files)
      .sort()
      .map((relative) => `${relative} ${sha256(files[relative])}`)
      .join(""),
  );
}

export function signalsDigest(object) {
  return sha256(canonical(object.signals));
}

/**
 * The class an object's signals actually support.
 *
 * Derived, and derived in this order: doing something beats everything, an
 * unreadable signal beats every green class, and only then do the green classes
 * apply. Age is not an input.
 */
export function deriveClass(object) {
  const signals = object.signals;
  if (IN_USE_SIGNALS.some((name) => signals[name] === "yes")) return "in_use";
  // A signal that could not be read is not a signal that said no.
  if (Object.values(signals).includes("unavailable")) return "unknown";
  if (signals.submodule_work === "yes") return "review";
  if (signals.dirty_tracked === "yes" || signals.dirty_untracked === "yes") return "review";
  if (signals.detached_or_null_branch === "yes") return "orphaned";
  // Ownership without a canonical parent is the definition of orphaned, and it
  // is a different thing from having no references: one has lost its parent,
  // the other never had one pointing at it.
  if (signals.canonical_parent === "no") return "orphaned";
  if (signals.in_canonical_line === "yes") return "landed";
  if (signals.unique_work === "yes") return "review";
  return object.kind === "worktree" ? "at_base" : "unreferenced";
}

export function validateReport(report, schema) {
  const errors = validateJsonSchema(report, schema).map((message) => `schema: ${message}`);
  if (errors.length > 0) return errors;

  if (report.invocation.kind !== "explicit_command") {
    // Deleting does not happen as a consequence of something else.
    errors.push("housekeeping_hidden_side_effect: housekeeping ran as a side effect, not as a command");
  }

  const byId = new Map(report.objects.map((object) => [object.object_id, object]));
  for (const object of report.objects) {
    const derived = deriveClass(object);
    if (object.classification !== derived) {
      // The green classification is machine-derived and reproducible, or it is
      // an opinion with a machine-readable shape.
      const refusal =
        derived === "unknown"
          ? "housekeeping_unavailable_signal_treated_as_safe"
          : derived === "in_use"
            ? "housekeeping_in_use_proposed"
            : derived === "review" && object.signals.submodule_work === "yes"
              ? "housekeeping_submodule_work_lost"
              : "housekeeping_age_as_proof";
      errors.push(`${refusal}: ${object.object_id} is recorded ${object.classification}, derived ${derived}`);
    }
    if (object.proposed) {
      if (object.classification === "in_use") {
        errors.push(`housekeeping_in_use_proposed: ${object.object_id}`);
      } else if (!GREEN.includes(object.classification)) {
        errors.push(`housekeeping_unknown_deleted: ${object.object_id} is ${object.classification} and was proposed in the batch`);
      }
      if (object.owner.proof !== "owned_by_this_project") {
        // "It is under our root" is a statement about a path.
        errors.push(`housekeeping_ownership_unproven: ${object.object_id}`);
      }
    }
    if (object.reclaimed_bytes && object.reclaimed_bytes.source !== "measured") {
      errors.push(`housekeeping_size_unmeasured: ${object.object_id} reports an estimated size`);
    }
  }

  const approvedIds = new Set();
  for (const approved of report.approval.approved_objects) {
    const object = byId.get(approved.object_id);
    approvedIds.add(approved.object_id);
    if (!object) {
      errors.push(`housekeeping_approval_not_exact: ${approved.object_id} is not in the report`);
      continue;
    }
    if (object.path !== approved.path) {
      errors.push(`housekeeping_approval_not_exact: ${approved.object_id} was approved at another path`);
    }
    if (approved.signals_digest !== signalsDigest(object)) {
      errors.push(`housekeeping_stale_approval: ${approved.object_id} changed after it was approved`);
    }
    if (CONFIRM_SEPARATELY.includes(object.classification) && !approved.separately_confirmed) {
      errors.push(`housekeeping_unknown_deleted: ${approved.object_id} is ${object.classification} and needs a separate confirmation`);
    }
  }

  for (const removed of report.outcome.removed) {
    const object = byId.get(removed.object_id);
    if (!approvedIds.has(removed.object_id)) {
      errors.push(`housekeeping_approval_not_exact: ${removed.object_id} was removed without being approved`);
    }
    if (removed.adapter === "model_shell") {
      // A raw rm -rf or a forced worktree remove from a model shell.
      errors.push(`housekeeping_untrusted_delete: ${removed.object_id}`);
    }
    if (object && removed.revalidated_signals_digest !== signalsDigest(object)) {
      // Revalidated immediately before the delete: a task that started between
      // the report and the approval finds its worktree still there.
      errors.push(`housekeeping_stale_approval: ${removed.object_id} was deleted on stale signals`);
    }
  }
  for (const failure of report.outcome.failed) {
    if (!failure.recoverable) {
      errors.push(`housekeeping_unrecoverable_failure: ${failure.object_id} (${failure.reason})`);
    }
  }
  if (!report.outcome.relisted) {
    errors.push("housekeeping_unrecoverable_failure: the inventory was not re-listed after the deletes");
  }

  const accounted = new Set([
    ...report.outcome.removed.map((entry) => entry.object_id),
    ...report.outcome.failed.map((entry) => entry.object_id),
    ...report.outcome.kept.map((entry) => entry.object_id),
  ]);
  for (const object of report.objects) {
    if (!accounted.has(object.object_id)) {
      errors.push(`housekeeping_unrecoverable_failure: ${object.object_id} appears in no outcome list`);
    }
  }
  return errors;
}

/** A second run over an unchanged host proposes nothing. */
export function proposedIds(report) {
  return report.objects.filter((object) => object.proposed).map((object) => object.object_id);
}

export function validateHousekeepingDesign(files) {
  const errors = [];
  const contract = files[CONTRACT_PATH];
  if (!contract.includes(CONTRACT_MARKER)) errors.push(`${CONTRACT_PATH}: missing ${CONTRACT_MARKER}`);
  if (!contract.includes(SCHEMA_PATH)) errors.push(`${CONTRACT_PATH}: does not point at ${SCHEMA_PATH}`);
  for (const refusal of REFUSALS) {
    if (!contract.includes(refusal)) errors.push(`${CONTRACT_PATH}: refusal ${refusal} is not documented`);
  }
  for (const name of CLASSES) {
    if (!contract.includes(name)) errors.push(`${CONTRACT_PATH}: class ${name} is not documented`);
  }
  if (!contract.includes("not a signal that says no")) {
    errors.push(`${CONTRACT_PATH}: does not state what an unavailable signal means`);
  }
  if (!contract.includes("Age is never proof of safety")) {
    errors.push(`${CONTRACT_PATH}: does not state that age is not proof`);
  }
  if (!contract.includes("Approval names objects, not a report")) {
    errors.push(`${CONTRACT_PATH}: does not state what is approved`);
  }
  if (!contract.includes("revalidated immediately before its delete")) {
    errors.push(`${CONTRACT_PATH}: does not state when an object is revalidated`);
  }

  let schema;
  try {
    schema = JSON.parse(files[SCHEMA_PATH]);
  } catch (error) {
    return [...errors, `${SCHEMA_PATH}: not valid JSON: ${error.message}`];
  }
  if (schema.additionalProperties !== false) {
    errors.push(`${SCHEMA_PATH}: root must be closed (additionalProperties:false)`);
  }
  const signal = schema.$defs?.signal?.enum ?? [];
  if (signal.join(",") !== "yes,no,unavailable") {
    errors.push(`${SCHEMA_PATH}: every signal must have three states, including unavailable`);
  }
  const classes = schema.properties?.objects?.items?.properties?.classification?.enum ?? [];
  if (classes.slice().sort().join(",") !== [...CLASSES].sort().join(",")) {
    errors.push(`${SCHEMA_PATH}: the seven classes must match the contract exactly`);
  }
  const approved = schema.properties?.approval?.properties?.approved_objects?.items?.required ?? [];
  for (const field of ["object_id", "path", "signals_digest"]) {
    if (!approved.includes(field)) {
      errors.push(`${SCHEMA_PATH}: an approval entry must name ${field}`);
    }
  }
  const size = schema.properties?.objects?.items?.properties?.reclaimed_bytes?.required ?? [];
  if (!size.includes("source")) {
    errors.push(`${SCHEMA_PATH}: a reclaimed size must say whether it was measured`);
  }

  for (const relative of [EXAMPLE_PATH, REFUSED_EXAMPLE_PATH]) {
    let report;
    try {
      report = JSON.parse(files[relative]);
    } catch (error) {
      errors.push(`${relative}: not valid JSON: ${error.message}`);
      continue;
    }
    const found = validateReport(report, schema);
    if (relative === EXAMPLE_PATH) {
      errors.push(...found.map((message) => `${relative}: ${message}`));
    } else if (found.length === 0) {
      errors.push(`${relative}: the refused example is accepted`);
    }
  }
  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = loadFiles();
  const errors = validateHousekeepingDesign(files);
  if (errors.length > 0) {
    console.error(errors.sort().join("\n"));
    process.exitCode = 1;
  } else {
    const schema = JSON.parse(files[SCHEMA_PATH]);
    const report = JSON.parse(files[EXAMPLE_PATH]);
    const refused = validateReport(JSON.parse(files[REFUSED_EXAMPLE_PATH]), schema);
    console.log("Housekeeping design validation PASS");
    console.log(`design_digest=${housekeepingDesignDigest(files)}`);
    console.log(`classes=${CLASSES.length} refusals=${REFUSALS.length} objects=${report.objects.length} proposed=${proposedIds(report).length} refused_example_findings=${refused.length}`);
  }
}
