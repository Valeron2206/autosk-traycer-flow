#!/usr/bin/env node

/**
 * Design-time validator for the issue #13 platform support matrix.
 *
 * The adapter's guarantees are not portable facts — they are what specific
 * syscalls do on specific filesystems. So the checks here are about whether a
 * row's claim could be true: a guarantee cannot be claimed without the syscall
 * family it rests on, a `supported` row cannot rest on unverified evidence, and
 * a row cannot both hold and miss the same guarantee. An unverified claim is not
 * a weaker claim, it is an unchecked one, and a table makes those look alike.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { checkRegistry } from "../src/host/doctor-checks.mjs";
import { CUSTODY_STEP_CHECKS, MODEL_STEP_CHECKS } from "../src/host/workflow-preflight.mjs";
import { validateJsonSchema } from "./validate-planning-ref-design.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CONTRACT_PATH = "docs/contracts/platform-support.md";
export const SCHEMA_PATH = "resources/platform-support/platform-support.schema.json";
export const MATRIX_PATH = "resources/platform-support/platform-support.v1.json";
/** The program matrix, which must own the custody service and the model account this matrix installs. */
export const PROGRAM_MATRIX_PATH = "resources/program-capabilities/matrix.v1.json";
/** The ref-custody policy schema, which must admit the ADR-102 profile beside the committed example. */
export const POLICY_SCHEMA_PATH = "resources/planning-publication/ref-custody-policy.schema.json";
/** The committed policy example, whose digest the signed wire goldens carry. */
export const POLICY_EXAMPLE_PATH = "resources/planning-publication/ref-custody-policy.example.json";
export const CONTRACT_MARKER = "<!-- platform-support-contract:v1 -->";

/**
 * The account the ref-custody helper runs as and the project's Git directory
 * belongs to under ADR-102, as the ref-custody policy names it.
 */
export const POLICY_INSTALLING_USER = "installing-user";

/** The adapter's guarantees, as ADR-028 states them. */
export const GUARANTEES = Object.freeze([
  "no_follow_per_component",
  "type_check",
  "owner_check",
  "mode_check",
  "device_check",
  "no_replace_rename",
]);

/** What each guarantee rests on. A claim without its syscall family is a wish. */
export const REQUIRED_SYSCALLS = Object.freeze({
  no_follow_per_component: ["at_plus_o_nofollow", "openat2"],
  no_replace_rename: ["rename_noreplace", "renameatx_np"],
});

/** Closed park reasons of section 7. */
export const PARK_REASONS = Object.freeze([
  "unsupported_platform",
  "unsupported_filesystem",
  "missing_guarantee",
  "world_writable_install",
  "helper_digest_mismatch",
  "helper_not_executable",
  "setuid_helper",
  "unverified_claim",
  "ref_custody_unavailable",
]);

/**
 * The ref-custody helper (02 §2, ADR-095, ADR-102) and who owns it: #5 the
 * helper, #13 the install that bootstraps it. Both are `required_for_v1`, and
 * each names the component in its implementation obligation, as ADR-092 holds
 * the preflight's primitives.
 */
export const CUSTODY_COMPONENT = "autosk-flow-ref-custody";
export const CUSTODY_OWNERS = Object.freeze([5, 13]);

/**
 * The helper's account model, as the schema must fix it (ADR-102). Unix
 * permissions are per uid (round 8 of #39, R8-1), and a Git directory two
 * accounts write either locks the principal out of it or makes the helper
 * trust files the principal writes (narrow re-review of 0ea81de, NH1–NH3). So
 * the helper runs as the installing user, whose ordinary repository the Git
 * directory stays; by protocol the helper alone writes the protected paths and
 * the installing user's account everything else; and what keeps a protected
 * ref where the helper left it is the OS against a model and detection against
 * the installing user's own tools.
 */
export const CUSTODY_ACCOUNT_CONSTANTS = Object.freeze([
  ["runs_as", "installing_user"],
  ["runs_as_installing_user", true],
  ["git_directory_owner", "installing_user"],
  ["protected_paths", ["refs/autosk/**", "logs/refs/autosk/**"]],
  ["git_directory_writers", { protected_refs: [CUSTODY_COMPONENT], ordinary_objects_and_refs: ["installing_user"] }],
  ["protected_ref_guard", {
    model_account: "denied_by_the_os",
    installing_user_tools: "detected_at_the_helper_cas",
    packed_protected_entry: "refused_by_the_preflight",
  }],
]);

/**
 * The account model processes run under (ADR-102) and who owns it: #13 the
 * account and the mechanism the privileged install sets up to start model
 * processes under it, #11 the model process environment, #18 the launch path.
 * Each is `required_for_v1` and names the account in its obligation.
 */
export const MODEL_ACCOUNT = "autosk-model";
export const MODEL_ACCOUNT_OWNERS = Object.freeze([11, 13, 18]);

/**
 * What the model account is, fixed in the schema rather than set by a record:
 * a dedicated account the privileged install creates, started by autoskd
 * through no setuid binary of this project and stopped by it as a whole tree
 * — autoskd cannot signal another uid's processes itself (review of 12a, M3)
 * — opening no Git directory of the project, for reads or writes (fix round 2),
 * and reaching no signer, secure store, keychain or daemon capability.
 */
export const MODEL_ACCOUNT_CONSTANTS = Object.freeze([
  ["runs_as", "dedicated_model_account"],
  ["runs_as_installing_user", false],
  ["created_by", "privileged_install"],
  ["launched_by", "autoskd"],
  ["setuid_binary", false],
  ["whole_tree_termination", true],
  ["git_directory_writes", false],
  ["git_directory_reads", false],
  ["signer_access", false],
  ["secure_store_access", false],
  ["keychain_access", false],
  ["daemon_capability", false],
]);

/**
 * The Git view of the model account (ADR-110, round 9 of #39, R9-1). The
 * account opens no Git directory of the project, so its own `git` found no
 * repository in a checkout and a suite that calls `git` failed under it. The
 * launch builds a repository the account owns at the checkout's root from a
 * pack of the handed commit and its line down to a base, which autoskd writes
 * as the installing user; nothing reads the view back — autoskd names its own
 * directories, the helper never opens it, and the installing user's Git
 * refuses it — and the account's own configuration, never the user's, trusts
 * the checkout for it. Who builds it, hands it over and proves it is #18, #9
 * and #13; each is `required_for_v1` and names it in its obligation.
 */
export const GIT_VIEW_OWNERS = Object.freeze([9, 13, 18]);
export const GIT_VIEW_CONSTANTS = Object.freeze([
  ["built_by", "launch_under_model_account"],
  ["at", "checkout_root"],
  ["owned_by", "model_account"],
  ["made_from", "handout_pack_written_by_autoskd"],
  ["holds", "handed_commit_and_line_to_base"],
  ["other_refs_reflogs_or_project_config", false],
  ["git_directory_variable_in_environment", false],
  ["safe_directory", "model_account_own_configuration"],
  ["read_by_autoskd", false],
  ["read_by_helper", false],
  ["installing_user_git", "refused_as_dubious_ownership"],
  ["covers", ["model_step", "check_running_project_code"]],
  ["teardown", "under_model_account_then_worktree_prune"],
]);

/**
 * What the one model account isolates (ADR-111). Round 9 of #39 (R9-2) found
 * isolation between model processes claimed, with no mechanism: every model
 * process runs under one uid and one worktree group, so a process can read and
 * rewrite another's worktree and session and signal or ptrace it (measured).
 * The record says so as constants — the account keeps the models from the
 * installing user and the project's Git directory and from nothing else,
 * v1 holds separate worktrees and sessions, contamination refused in content
 * and whole-tree termination, OS isolation between model processes is #197's,
 * and autoskd's closing of a finished step's roots helps later processes and
 * not concurrent ones — and #13 (the probe) and #18 (the launch path) each name
 * it in their obligations.
 */
export const PROCESS_ISOLATION_OWNERS = Object.freeze([13, 18]);
export const PROCESS_ISOLATION_CONSTANTS = Object.freeze([
  ["between_model_processes", "not_isolated_by_the_os"],
  ["kept_from_the_account", ["installing_user", "project_git_directory"]],
  ["held_by_v1", ["separate_worktrees_and_sessions", "content_contamination_refused", "whole_tree_termination"]],
  ["os_isolation_owner_issue", 197],
  ["finished_step_roots", "closed_by_autoskd_at_step_end"],
  ["closed_root_mode", "0700"],
  ["helps", "later_processes"],
  ["does_not_help", ["concurrent_processes"]],
]);

export function loadFiles() {
  const files = {};
  for (const relative of [CONTRACT_PATH, SCHEMA_PATH, MATRIX_PATH, PROGRAM_MATRIX_PATH, POLICY_SCHEMA_PATH, POLICY_EXAMPLE_PATH]) {
    files[relative] = readFileSync(path.join(ROOT, relative), "utf8");
  }
  return files;
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function platformSupportDesignDigest(files) {
  return sha256(
    Object.keys(files)
      .sort()
      .map((relative) => `${relative} ${sha256(files[relative])}`)
      .join(""),
  );
}

export function validateMatrix(matrix, schema) {
  const errors = validateJsonSchema(matrix, schema).map((message) => `schema: ${message}`);
  if (errors.length > 0) return errors;

  const seen = new Set();
  for (const row of matrix.rows) {
    const at = `${row.os}/${row.arch} on ${row.filesystems.join(",")}`;
    const key = `${row.os}/${row.arch}/${[...row.filesystems].sort().join(",")}`;
    if (seen.has(key)) errors.push(`${at}: declared twice`);
    seen.add(key);

    const held = new Set(row.guarantees);
    const missing = new Set(row.missing_guarantees ?? []);
    for (const guarantee of held) {
      if (missing.has(guarantee)) {
        errors.push(`${at}: ${guarantee} is listed as both held and missing`);
      }
    }
    // Every guarantee is accounted for. A guarantee that is neither held nor
    // missing is one the table quietly declines to answer about.
    for (const guarantee of GUARANTEES) {
      if (!held.has(guarantee) && !missing.has(guarantee)) {
        errors.push(`${at}: says nothing about ${guarantee}`);
      }
    }

    // A guarantee cannot be claimed without a syscall family that provides it.
    for (const [guarantee, families] of Object.entries(REQUIRED_SYSCALLS)) {
      if (held.has(guarantee) && !families.some((family) => row.syscall_family.includes(family))) {
        errors.push(`${at}: claims ${guarantee} without any of ${families.join(" or ")}`);
      }
    }

    // `supported` means verified on every change. Anything else is a claim about
    // a platform nobody is currently checking.
    if (row.level === "supported" && row.evidence !== "ci") {
      errors.push(`${at}: level supported requires CI evidence, not ${row.evidence} (unverified_claim)`);
    }
    if (row.evidence === "not_verified" && held.size > 0) {
      errors.push(`${at}: claims guarantees with no verification at all (unverified_claim)`);
    }
    // A level and its guarantees must agree in both directions.
    if (row.level !== "unsupported" && missing.size > 0) {
      errors.push(`${at}: is ${row.level} but is missing ${[...missing].join(", ")}`);
    }
    if (row.level === "unsupported" && missing.size === 0) {
      errors.push(`${at}: is unsupported but names no missing guarantee`);
    }
    if (row.level === "unsupported" && !row.note) {
      errors.push(`${at}: an unsupported row must say why, not only that`);
    }
  }

  // At least one row must actually be supported, or the matrix describes a
  // product that runs nowhere.
  if (!matrix.rows.some((row) => row.level === "supported")) {
    errors.push("no row is supported, so the adapter is claimed nowhere");
  }
  // macOS is named in the issue as a target that must really be supported.
  if (!matrix.rows.some((row) => row.os === "darwin" && row.level === "supported")) {
    errors.push("no supported darwin row, which #13 requires by name");
  }

  const install = matrix.install;
  if (install.setuid_allowed || install.setgid_allowed) {
    errors.push("the helper is never setuid or setgid");
  }
  if (install.world_writable_install_allowed) {
    errors.push("a world-writable install directory is a park reason, not a configuration");
  }
  if (!install.digest_bound_to_runtime_identity) {
    errors.push("the helper digest must be bound into runtime identity (#10)");
  }
  // The ref-custody helper is a separately shipped process of the installing
  // user, not a fourth binary of §5: the schema fixes what it is, this says
  // who owns it.
  const service = install.ref_custody_service;
  if (!service || typeof service !== "object") {
    errors.push("install.ref_custody_service: the ref-custody helper has no install record");
  } else if (JSON.stringify(service.owner_issues) !== JSON.stringify(CUSTODY_OWNERS)) {
    errors.push(`install.ref_custody_service.owner_issues must be ${JSON.stringify(CUSTODY_OWNERS)}: #5 owns the helper, #13 the install that bootstraps it`);
  }
  // The model processes are the one account apart from the installing user's
  // (ADR-102): the schema fixes what it is, this says who owns it.
  const model = install.model_account;
  if (!model || typeof model !== "object") {
    errors.push("install.model_account: the model processes have no install record");
  } else if (JSON.stringify(model.owner_issues) !== JSON.stringify(MODEL_ACCOUNT_OWNERS)) {
    errors.push(`install.model_account.owner_issues must be ${JSON.stringify(MODEL_ACCOUNT_OWNERS)}: #13 owns the account and its launch mechanism, #11 the model process environment, #18 the launch path`);
  }
  return errors;
}

/**
 * The custody service's owners, held to the program matrix: each owner is a
 * `required_for_v1` record whose implementation obligation names the component
 * in backticks. An install record no v1 record owns is a sentence, not an
 * obligation (round 7 of #39, R7-3 and R7-24).
 */
export function custodyServiceErrors(matrix, program) {
  const service = matrix?.install?.ref_custody_service;
  if (!service || typeof service !== "object") {
    return ["install.ref_custody_service: the ref-custody helper has no install record"];
  }
  const records = Array.isArray(program?.records) ? program.records : [];
  if (records.length === 0) return [`${PROGRAM_MATRIX_PATH}: no records to hold the custody service to`];
  const errors = [];
  for (const issue of Array.isArray(service.owner_issues) ? service.owner_issues : []) {
    const record = records.find((entry) => entry?.issue_number === issue);
    if (!record) {
      errors.push(`ref_custody_service owner #${issue} is not a record of the program matrix`);
      continue;
    }
    if (record.lifecycle !== "required_for_v1") {
      errors.push(`ref_custody_service owner #${issue} is ${record.lifecycle}, not required_for_v1`);
    }
    if (!String(record.implementation_obligation_before_mvp ?? "").includes(`\`${CUSTODY_COMPONENT}\``)) {
      errors.push(`ref_custody_service owner #${issue} does not name \`${CUSTODY_COMPONENT}\` in its implementation obligation`);
    }
  }
  return errors;
}

/**
 * The model account's owners, held to the program matrix as the custody
 * service's are: each is a `required_for_v1` record whose implementation
 * obligation names the account in backticks. Round 8 of #39 (R8-1) found the
 * "model sandbox" 03 §5 rests on with no v1 owner and no record at all.
 */
export function modelAccountErrors(matrix, program) {
  const model = matrix?.install?.model_account;
  if (!model || typeof model !== "object") {
    return ["install.model_account: the model processes have no install record"];
  }
  const records = Array.isArray(program?.records) ? program.records : [];
  if (records.length === 0) return [`${PROGRAM_MATRIX_PATH}: no records to hold the model account to`];
  const errors = [];
  for (const issue of Array.isArray(model.owner_issues) ? model.owner_issues : []) {
    const record = records.find((entry) => entry?.issue_number === issue);
    if (!record) {
      errors.push(`model_account owner #${issue} is not a record of the program matrix`);
      continue;
    }
    if (record.lifecycle !== "required_for_v1") {
      errors.push(`model_account owner #${issue} is ${record.lifecycle}, not required_for_v1`);
    }
    if (!String(record.implementation_obligation_before_mvp ?? "").includes(`\`${MODEL_ACCOUNT}\``)) {
      errors.push(`model_account owner #${issue} does not name \`${MODEL_ACCOUNT}\` in its implementation obligation`);
    }
  }
  return errors;
}

/**
 * The Git view's owners, held to the program matrix as the model account's are:
 * each is a `required_for_v1` record whose implementation obligation names the
 * view (`git_view`) in backticks, and the record names exactly the owners of
 * `GIT_VIEW_OWNERS`. Round 9 of #39 (R9-1) found checks that run the project's
 * own code under an account with no Git, and no owner for what would give them
 * one.
 */
export function gitViewErrors(matrix, program) {
  const view = matrix?.install?.model_account?.git_view;
  if (!view || typeof view !== "object") {
    return ["install.model_account.git_view: the model account's checks and steps have no Git view record"];
  }
  const records = Array.isArray(program?.records) ? program.records : [];
  if (records.length === 0) return [`${PROGRAM_MATRIX_PATH}: no records to hold the Git view to`];
  const errors = [];
  if (!isDeepStrictEqual(view.owner_issues, GIT_VIEW_OWNERS)) {
    errors.push(`git_view.owner_issues must be ${JSON.stringify(GIT_VIEW_OWNERS)}: #18 builds it, #9 hands it to the aggregate's checks, #13 proves it`);
  }
  for (const issue of Array.isArray(view.owner_issues) ? view.owner_issues : []) {
    const record = records.find((entry) => entry?.issue_number === issue);
    if (!record) {
      errors.push(`git_view owner #${issue} is not a record of the program matrix`);
      continue;
    }
    if (record.lifecycle !== "required_for_v1") {
      errors.push(`git_view owner #${issue} is ${record.lifecycle}, not required_for_v1`);
    }
    if (!String(record.implementation_obligation_before_mvp ?? "").includes("`git_view`")) {
      errors.push(`git_view owner #${issue} does not name \`git_view\` in its implementation obligation`);
    }
  }
  return errors;
}

/**
 * The process-isolation record, held to `PROCESS_ISOLATION_CONSTANTS` and to
 * the program matrix: its owners are exactly `PROCESS_ISOLATION_OWNERS`, each a
 * `required_for_v1` record whose implementation obligation names
 * `process_isolation` in backticks.
 */
export function processIsolationErrors(matrix, program) {
  const record = matrix?.install?.model_account?.process_isolation;
  if (!record || typeof record !== "object") {
    return ["install.model_account.process_isolation: the model account's isolation between model processes has no record"];
  }
  const records = Array.isArray(program?.records) ? program.records : [];
  if (records.length === 0) return [`${PROGRAM_MATRIX_PATH}: no records to hold the process isolation to`];
  const errors = [];
  if (!isDeepStrictEqual(record.owner_issues, PROCESS_ISOLATION_OWNERS)) {
    errors.push(`process_isolation.owner_issues must be ${JSON.stringify(PROCESS_ISOLATION_OWNERS)}: #18 closes a finished step's roots, #13 proves it`);
  }
  for (const [field, expected] of PROCESS_ISOLATION_CONSTANTS) {
    if (!isDeepStrictEqual(record[field], expected)) {
      errors.push(`process_isolation.${field} must be ${JSON.stringify(expected)}: one uid does not isolate model processes from each other`);
    }
  }
  for (const issue of Array.isArray(record.owner_issues) ? record.owner_issues : []) {
    const owner = records.find((entry) => entry?.issue_number === issue);
    if (!owner) {
      errors.push(`process_isolation owner #${issue} is not a record of the program matrix`);
      continue;
    }
    if (owner.lifecycle !== "required_for_v1") {
      errors.push(`process_isolation owner #${issue} is ${owner.lifecycle}, not required_for_v1`);
    }
    if (!String(owner.implementation_obligation_before_mvp ?? "").includes("`process_isolation`")) {
      errors.push(`process_isolation owner #${issue} does not name \`process_isolation\` in its implementation obligation`);
    }
  }
  return errors;
}

/**
 * The ADR-102 form of a ref-custody policy: the helper runs as the installing
 * user, whose ordinary repository the Git directory is (`helper_runs_as`, each
 * profile's `helper_account` and `owner_account`, the packed-refs policy's
 * `maintenance_owner`); a model can replace its worktree's gitfile, so it is
 * not read-only (`gitfile_read_only=false`); and the one topology entry is the
 * project's common Git directory, closed to every other account (`0700`).
 */
export function adr102PolicyProfile(example) {
  const value = structuredClone(example ?? {});
  value.helper_runs_as = POLICY_INSTALLING_USER;
  for (const entry of Array.isArray(value.supported_platforms) ? value.supported_platforms : []) {
    Object.assign(entry, { helper_account: POLICY_INSTALLING_USER, owner_account: POLICY_INSTALLING_USER, gitfile_read_only: false });
  }
  if (value.packed_refs_policy && typeof value.packed_refs_policy === "object") value.packed_refs_policy.maintenance_owner = POLICY_INSTALLING_USER;
  value.parent_topology = (Array.isArray(value.parent_topology) ? value.parent_topology : [])
    .filter((entry) => entry?.path_role === "project-common-git-dir")
    .map((entry) => ({ ...entry, mode_octal: "0700" }));
  return value;
}

/**
 * The ref-custody policy schema, held to ADR-102 (fix round 2 of debt 12a):
 * it admits the committed example, whose digest the signed wire goldens carry
 * and which only #5's re-signing may change; it admits that example's ADR-102
 * form; and it refuses a policy that mixes the two, a withdrawn service
 * account beside the installing user. The narrow re-review of 0ea81de found
 * the `3770` topology this replaces to be one half of a Git directory two
 * accounts write (H1, Lows 7, 8 and 10).
 */
export function policyProfileErrors(policySchema, example) {
  const valid = (value) => validateJsonSchema(value, policySchema, policySchema).length === 0;
  const errors = [];
  if (!valid(example)) {
    errors.push(`${POLICY_SCHEMA_PATH}: does not admit the committed example the signed goldens bind (${POLICY_EXAMPLE_PATH})`);
  }
  const profile = adr102PolicyProfile(example);
  if (!valid(profile)) {
    errors.push(`${POLICY_SCHEMA_PATH}: does not admit the ADR-102 profile (helper_runs_as=${POLICY_INSTALLING_USER})`);
  }
  const mixed = structuredClone(profile);
  if (Array.isArray(mixed.supported_platforms) && mixed.supported_platforms.length > 0) {
    mixed.supported_platforms[0].helper_account = "autosk-ref-custody";
  }
  if (valid(mixed)) {
    errors.push(`${POLICY_SCHEMA_PATH}: admits a policy that mixes the ADR-102 profile with a withdrawn service account`);
  }
  return errors;
}

/** The doctor's check ids and the preflight's derived sets, as the code declares them. */
function declaredChecks() {
  return {
    registered: checkRegistry({}).map((check) => check.id),
    modelStepChecks: [...MODEL_STEP_CHECKS],
    custodyStepChecks: [...CUSTODY_STEP_CHECKS],
  };
}

/**
 * Each install record names the doctor check that proves it (`checked_by`),
 * and that check is registered and required where the record needs it: the
 * model account of every workflow that runs a model step, the custody install
 * of every workflow that reaches a step asking the helper — both derived from
 * the graph by the preflight. Round 8 of #39 (R8-13) found
 * `ref_custody_unavailable` with no producer and no check probing the custody
 * install before a write; a record naming a check nobody runs, or one no
 * workflow requires, would be that gap again (ADR-102). Review of 12a (M1):
 * the custody check was held to two phases, which left Quick and a Ticket out.
 */
export function installCheckErrors(matrix, sets = declaredChecks()) {
  const list = (value) => (Array.isArray(value) ? value : []);
  const registered = new Set(list(sets?.registered));
  const errors = [];
  const named = (record, where) => {
    const id = record?.checked_by;
    if (typeof id !== "string" || id.length === 0) {
      errors.push(`install.${where}.checked_by names no check`);
      return null;
    }
    if (!registered.has(id)) errors.push(`install.${where}.checked_by: \`${id}\` is not a check the doctor registers`);
    return id;
  };
  const model = named(matrix?.install?.model_account, "model_account");
  if (model !== null && !list(sets?.modelStepChecks).includes(model)) {
    errors.push(`install.model_account.checked_by: \`${model}\` is not required of every model step (MODEL_STEP_CHECKS)`);
  }
  const custody = named(matrix?.install?.ref_custody_service, "ref_custody_service");
  if (custody !== null && !list(sets?.custodyStepChecks).includes(custody)) {
    errors.push(`install.ref_custody_service.checked_by: \`${custody}\` is not required of every workflow that asks the helper (CUSTODY_STEP_CHECKS)`);
  }
  return errors;
}

export function validatePlatformSupportDesign(files) {
  const errors = [];
  const contract = files[CONTRACT_PATH];
  if (!contract.includes(CONTRACT_MARKER)) errors.push(`${CONTRACT_PATH}: missing ${CONTRACT_MARKER}`);
  if (!contract.includes(SCHEMA_PATH)) errors.push(`${CONTRACT_PATH}: does not point at ${SCHEMA_PATH}`);
  for (const reason of PARK_REASONS) {
    if (!contract.includes(reason)) errors.push(`${CONTRACT_PATH}: park reason ${reason} is not documented`);
  }
  // The three support levels have different meanings and the contract must give
  // them, or "best_effort" becomes a synonym for "supported" in practice.
  for (const level of ["supported", "best_effort", "unsupported"]) {
    if (!contract.includes(level)) errors.push(`${CONTRACT_PATH}: does not define the level ${level}`);
  }
  // The window the digest check cannot close is stated rather than claimed away.
  if (!contract.includes("does not close the replacement window")) {
    errors.push(`${CONTRACT_PATH}: does not state the limit of a pre-launch digest check`);
  }
  // Who a model process runs as is the contract's to say, by name (ADR-102).
  if (!contract.includes(`\`${MODEL_ACCOUNT}\``)) {
    errors.push(`${CONTRACT_PATH}: does not name the model account \`${MODEL_ACCOUNT}\``);
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
  // The three install prohibitions are constants in the schema, not booleans a
  // matrix could set either way.
  for (const [field, expected] of [
    ["setuid_allowed", false],
    ["setgid_allowed", false],
    ["world_writable_install_allowed", false],
    ["digest_bound_to_runtime_identity", true],
  ]) {
    const node = schema.properties?.install?.properties?.[field];
    if (!node || node.const !== expected) {
      errors.push(`${SCHEMA_PATH}: install.${field} must be fixed to ${expected}`);
    }
  }
  // So are the account §5's binaries run as, who writes the project's Git
  // directory by account, and what the model account is.
  if (schema.properties?.install?.properties?.binaries_run_as?.const !== "installing_user") {
    errors.push(`${SCHEMA_PATH}: install.binaries_run_as must be fixed to installing_user`);
  }
  const custodyNode = schema.properties?.install?.properties?.ref_custody_service;
  for (const [field, expected] of CUSTODY_ACCOUNT_CONSTANTS) {
    if (!isDeepStrictEqual(custodyNode?.properties?.[field]?.const, expected)) {
      errors.push(`${SCHEMA_PATH}: install.ref_custody_service.${field} must be fixed to ${JSON.stringify(expected)}`);
    }
  }
  // Its bootstrap needs no administrator; the one privileged step there is
  // is the model account's (ADR-102).
  if (custodyNode?.properties?.bootstrap?.properties?.requires_administrator?.const !== false) {
    errors.push(`${SCHEMA_PATH}: install.ref_custody_service.bootstrap.requires_administrator must be fixed to false`);
  }
  const modelNode = schema.properties?.install?.properties?.model_account;
  if (modelNode?.additionalProperties !== false) {
    errors.push(`${SCHEMA_PATH}: install.model_account must be closed (additionalProperties:false)`);
  }
  for (const [field, expected] of [["account", MODEL_ACCOUNT], ...MODEL_ACCOUNT_CONSTANTS]) {
    if (modelNode?.properties?.[field]?.const !== expected) {
      errors.push(`${SCHEMA_PATH}: install.model_account.${field} must be fixed to ${expected}`);
    }
  }
  const viewNode = modelNode?.properties?.git_view;
  if (viewNode?.additionalProperties !== false) {
    errors.push(`${SCHEMA_PATH}: install.model_account.git_view must be closed (additionalProperties:false)`);
  }
  if (!Array.isArray(modelNode?.required) || !modelNode.required.includes("git_view")) {
    errors.push(`${SCHEMA_PATH}: install.model_account must require git_view`);
  }
  for (const [field, expected] of GIT_VIEW_CONSTANTS) {
    if (!isDeepStrictEqual(viewNode?.properties?.[field]?.const, expected)) {
      errors.push(`${SCHEMA_PATH}: install.model_account.git_view.${field} must be fixed to ${JSON.stringify(expected)}`);
    }
  }
  const isolationNode = modelNode?.properties?.process_isolation;
  if (isolationNode?.additionalProperties !== false) {
    errors.push(`${SCHEMA_PATH}: install.model_account.process_isolation must be closed (additionalProperties:false)`);
  }
  if (!Array.isArray(modelNode?.required) || !modelNode.required.includes("process_isolation")) {
    errors.push(`${SCHEMA_PATH}: install.model_account must require process_isolation`);
  }
  for (const [field, expected] of PROCESS_ISOLATION_CONSTANTS) {
    if (!isDeepStrictEqual(isolationNode?.properties?.[field]?.const, expected)) {
      errors.push(`${SCHEMA_PATH}: install.model_account.process_isolation.${field} must be fixed to ${JSON.stringify(expected)}`);
    }
  }
  if (modelNode?.properties?.privileged_install?.properties?.requires_administrator?.const !== true) {
    errors.push(`${SCHEMA_PATH}: install.model_account.privileged_install.requires_administrator must be fixed to true`);
  }
  // The ref-custody policy admits the ADR-102 profile beside the committed
  // example, and refuses a mix of the two (§5a).
  let policySchema;
  let policyExample;
  try {
    policySchema = JSON.parse(files[POLICY_SCHEMA_PATH]);
    policyExample = JSON.parse(files[POLICY_EXAMPLE_PATH]);
  } catch (error) {
    return [...errors, `${POLICY_SCHEMA_PATH} or ${POLICY_EXAMPLE_PATH}: not valid JSON: ${error.message}`];
  }
  errors.push(...policyProfileErrors(policySchema, policyExample));

  let matrix;
  try {
    matrix = JSON.parse(files[MATRIX_PATH]);
  } catch (error) {
    return [...errors, `${MATRIX_PATH}: not valid JSON: ${error.message}`];
  }
  errors.push(...validateMatrix(matrix, schema).map((message) => `${MATRIX_PATH}: ${message}`));

  let program;
  try {
    program = JSON.parse(files[PROGRAM_MATRIX_PATH]);
  } catch (error) {
    return [...errors, `${PROGRAM_MATRIX_PATH}: not valid JSON: ${error.message}`];
  }
  errors.push(...custodyServiceErrors(matrix, program).map((message) => `${MATRIX_PATH}: ${message}`));
  errors.push(...modelAccountErrors(matrix, program).map((message) => `${MATRIX_PATH}: ${message}`));
  errors.push(...gitViewErrors(matrix, program).map((message) => `${MATRIX_PATH}: ${message}`));
  errors.push(...processIsolationErrors(matrix, program).map((message) => `${MATRIX_PATH}: ${message}`));
  errors.push(...installCheckErrors(matrix).map((message) => `${MATRIX_PATH}: ${message}`));
  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = loadFiles();
  const errors = validatePlatformSupportDesign(files);
  if (errors.length > 0) {
    console.error(errors.sort().join("\n"));
    process.exitCode = 1;
  } else {
    const matrix = JSON.parse(files[MATRIX_PATH]);
    const byLevel = (level) => matrix.rows.filter((row) => row.level === level).length;
    console.log("Platform support design validation PASS");
    console.log(`design_digest=${platformSupportDesignDigest(files)}`);
    console.log(
      `rows=${matrix.rows.length} supported=${byLevel("supported")} ` +
        `best_effort=${byLevel("best_effort")} unsupported=${byLevel("unsupported")}`,
    );
  }
}
