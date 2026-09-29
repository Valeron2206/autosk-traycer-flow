/**
 * Tests for the issue #13 platform-support validator.
 *
 * A support matrix is the easiest kind of document to make untrue: a row can
 * claim a guarantee the platform cannot give, or claim verification nobody
 * performs, and the table looks identical either way. Each case here is one of
 * those two lies.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  CONTRACT_PATH,
  GUARANTEES,
  MATRIX_PATH,
  PARK_REASONS,
  REQUIRED_SYSCALLS,
  ROOT,
  SCHEMA_PATH,
  loadFiles,
  platformSupportDesignDigest,
  validateMatrix,
  validatePlatformSupportDesign,
} from "../scripts/validate-platform-support.mjs";

const files = loadFiles();
const schema = JSON.parse(files[SCHEMA_PATH]);

function matrix() {
  return JSON.parse(files[MATRIX_PATH]);
}

function mutated(mutate) {
  const value = matrix();
  mutate(value);
  return value;
}

function assertRejects(value, pattern) {
  const errors = validateMatrix(value, schema);
  assert.ok(
    errors.some((message) => pattern.test(message)),
    `expected an error matching ${pattern}, got:\n${errors.join("\n") || "(none)"}`,
  );
}

function rowOn(value, filesystem) {
  return value.rows.find((row) => row.filesystems.includes(filesystem));
}

test("the shipped design validates", () => {
  assert.deepEqual(validatePlatformSupportDesign(files), []);
});

test("the shipped matrix validates", () => {
  assert.deepEqual(validateMatrix(matrix(), schema), []);
});

test("every row accounts for every guarantee", () => {
  // A guarantee that is neither held nor missing is one the table quietly
  // declines to answer about, which reads as held to anyone skimming it.
  for (const row of matrix().rows) {
    const accounted = new Set([...row.guarantees, ...(row.missing_guarantees ?? [])]);
    for (const guarantee of GUARANTEES) {
      assert.ok(accounted.has(guarantee), `${row.os}/${row.filesystems} says nothing about ${guarantee}`);
    }
  }
  assertRejects(
    mutated((value) => {
      const row = rowOn(value, "apfs");
      row.guarantees = row.guarantees.filter((entry) => entry !== "device_check");
    }),
    /says nothing about device_check/u,
  );
});

test("a guarantee cannot be both held and missing", () => {
  assertRejects(
    mutated((value) => {
      const row = rowOn(value, "nfs");
      row.guarantees = [...row.guarantees, "device_check"];
    }),
    /device_check is listed as both held and missing/u,
  );
});

test("a guarantee cannot be claimed without the syscall family it rests on", () => {
  // The adapter's guarantees are what specific syscalls do. A claim without them
  // is a wish.
  for (const [guarantee, families] of Object.entries(REQUIRED_SYSCALLS)) {
    assertRejects(
      mutated((value) => {
        const row = rowOn(value, "ext4");
        row.syscall_family = row.syscall_family.filter((family) => !families.includes(family));
        if (!row.guarantees.includes(guarantee)) row.guarantees = [...row.guarantees, guarantee];
      }),
      new RegExp(`claims ${guarantee} without any of`, "u"),
    );
  }
});

test("supported requires CI evidence, not a manual smoke", () => {
  // Otherwise `supported` means "believed to work", and a regression is found by
  // a user rather than by the pipeline.
  assertRejects(
    mutated((value) => {
      rowOn(value, "apfs").evidence = "manual_smoke";
    }),
    /level supported requires CI evidence.*\(unverified_claim\)/u,
  );
});

test("an unverified row may not claim guarantees at all", () => {
  assertRejects(
    mutated((value) => {
      rowOn(value, "apfs").evidence = "not_verified";
    }),
    /claims guarantees with no verification at all/u,
  );
});

test("the level and the guarantees must agree in both directions", () => {
  assertRejects(
    mutated((value) => {
      rowOn(value, "nfs").level = "best_effort";
    }),
    /is best_effort but is missing/u,
  );
  assertRejects(
    mutated((value) => {
      const row = rowOn(value, "exfat");
      row.guarantees = [...GUARANTEES];
      delete row.missing_guarantees;
    }),
    /is unsupported but names no missing guarantee/u,
  );
});

test("an unsupported row must say why, not only that", () => {
  assertRejects(
    mutated((value) => {
      delete rowOn(value, "overlayfs").note;
    }),
    /must say why, not only that/u,
  );
});

test("the matrix must support something, and macOS by name", () => {
  assertRejects(
    mutated((value) => {
      for (const row of value.rows) if (row.level === "supported") row.level = "best_effort";
    }),
    /no row is supported/u,
  );
  assertRejects(
    mutated((value) => {
      for (const row of value.rows) {
        if (row.os === "darwin" && row.level === "supported") row.level = "best_effort";
      }
    }),
    /no supported darwin row, which #13 requires by name/u,
  );
});

test("a platform and filesystem set is declared once", () => {
  assertRejects(
    mutated((value) => {
      value.rows.push({ ...rowOn(value, "apfs") });
    }),
    /declared twice/u,
  );
});

test("the helper is never setuid, setgid, or installed world-writable", () => {
  // These are constants in the schema rather than booleans a matrix could set
  // either way, so the prohibition cannot be configured away.
  for (const [field, expected] of [
    ["setuid_allowed", false],
    ["setgid_allowed", false],
    ["world_writable_install_allowed", false],
    ["digest_bound_to_runtime_identity", true],
  ]) {
    assert.equal(schema.properties.install.properties[field].const, expected);
  }
  assertRejects(
    mutated((value) => {
      value.install.setuid_allowed = true;
    }),
    /schema:|never setuid or setgid/u,
  );
});

test("the contract states the limit of a pre-launch digest check", () => {
  // A SHA taken before exec does not close the replacement window, and saying so
  // is the difference between a mitigation and a claim.
  const contract = readFileSync(path.join(ROOT, CONTRACT_PATH), "utf8");
  assert.ok(contract.includes("does not close the replacement window"));
});

test("the contract defines all three support levels", () => {
  const contract = readFileSync(path.join(ROOT, CONTRACT_PATH), "utf8");
  for (const level of ["supported", "best_effort", "unsupported"]) {
    assert.ok(contract.includes(level), `${level} is not defined`);
  }
});

test("every park reason is documented in the contract", () => {
  const contract = readFileSync(path.join(ROOT, CONTRACT_PATH), "utf8");
  for (const reason of PARK_REASONS) {
    assert.ok(contract.includes(reason), `${reason} is not documented`);
  }
});

test("the design digest changes when any shipped file changes", () => {
  const before = platformSupportDesignDigest(files);
  const after = platformSupportDesignDigest({ ...files, [CONTRACT_PATH]: `${files[CONTRACT_PATH]}\n` });
  assert.notEqual(before, after);
});

// --- debt 11a: the separate-account custody service is an install record (R7-3) --

test("the ref-custody helper runs as the installing user, and its bootstrap needs no administrator (ADR-102, narrow re-review)", () => {
  // Round 7 of #39 (R7-3) gave the helper a service account and a privileged
  // install. The narrow re-review of 0ea81de measured the Git directory that
  // made: two accounts writing one repository either lock the principal out of
  // it or make the helper trust files the principal writes (NH1–NH3). ADR-102
  // withdrew both: the helper runs as the installing user, the Git directory
  // stays the user's ordinary repository, and the model account is the OS
  // boundary.
  const service = matrix().install.ref_custody_service;
  assert.equal(service.component, "autosk-flow-ref-custody");
  assert.equal(service.runs_as, "installing_user");
  assert.equal(service.runs_as_installing_user, true);
  assert.equal(service.git_directory_owner, "installing_user");
  assert.equal(service.protected_ref_writer, "autosk-flow-ref-custody");
  assert.deepEqual(service.owner_issues, [5, 13]);
  assert.equal(Object.hasOwn(service, "privileged_install"), false, "the helper's install needs no administrator");
  assert.equal(Object.hasOwn(service, "user_account_git_writes"), false, "the OS does not keep the installing user off a protected ref");
  assert.equal(service.bootstrap.requires_administrator, false);
  const bootstrap = service.bootstrap.effects.join("\n");
  for (const effect of [
    /registers the helper as the installing user's launchd agent or systemd user unit/u,
    /closes the project's Git directory to every other account \(mode 0700\)/u,
    /pins gc\.packRefs=false/u,
    /extensions\.worktreeConfig/u,
    /records the bootstrap receipt/u,
  ]) {
    assert.match(bootstrap, effect);
  }
  assertRejects(mutated((value) => { delete value.install.ref_custody_service; }), /ref_custody_service/u);
  for (const [field, wrong] of [
    ["runs_as", "dedicated_service_account"],
    ["runs_as_installing_user", false],
    ["git_directory_owner", "autosk-custody"],
    ["protected_ref_writer", "autoskd"],
  ]) {
    assertRejects(mutated((value) => { value.install.ref_custody_service[field] = wrong; }), /ref_custody_service/u);
  }
  assertRejects(mutated((value) => { value.install.ref_custody_service.bootstrap.requires_administrator = true; }), /ref_custody_service/u);
  assertRejects(mutated((value) => {
    value.install.ref_custody_service.privileged_install = { requires_administrator: true, setuid_helper: false, effects: ["creates the dedicated service account"] };
  }), /ref_custody_service/u);
  assertRejects(mutated((value) => { value.install.ref_custody_service.owner_issues = [5]; }), /owner_issues/u);
});

test("the custody helper's owner message says whose each part is (CodeRabbit on #274; review of 99fd30b, nit)", () => {
  const errors = validateMatrix(mutated((value) => { value.install.ref_custody_service.owner_issues = [5]; }), schema);
  assert.ok(
    errors.includes("install.ref_custody_service.owner_issues must be [5,13]: #5 owns the helper, #13 the install that bootstraps it"),
    errors.join("\n"),
  );
  // ADR-102 withdrew the privileged install the message used to give #13.
  assert.equal(errors.some((message) => /privileged/u.test(message)), false, errors.join("\n"));
});

test("the custody service's owners are v1 records whose obligations name it", async () => {
  // The same two-way hold ADR-092 gives the preflight's primitives: an install
  // record the program matrix does not own is a sentence, not an obligation.
  const { custodyServiceErrors, PROGRAM_MATRIX_PATH } = await import("../scripts/validate-platform-support.mjs");
  const program = () => JSON.parse(files[PROGRAM_MATRIX_PATH]);
  assert.deepEqual(custodyServiceErrors(matrix(), program()), []);
  for (const issue of [5, 13]) {
    const record = program().records.find((entry) => entry.issue_number === issue);
    assert.match(record.implementation_obligation_before_mvp, /`autosk-flow-ref-custody`/u, `#${issue}`);
    const unnamed = program();
    const owner = unnamed.records.find((entry) => entry.issue_number === issue);
    owner.implementation_obligation_before_mvp = owner.implementation_obligation_before_mvp.replaceAll("`autosk-flow-ref-custody`", "the helper");
    assert.match(custodyServiceErrors(matrix(), unnamed).join("\n"), new RegExp(`#${issue}`, "u"));
    const later = program();
    later.records.find((entry) => entry.issue_number === issue).lifecycle = "planned_after_v1";
    assert.match(custodyServiceErrors(matrix(), later).join("\n"), new RegExp(`#${issue}.*required_for_v1`, "u"));
  }
  const missing = program();
  missing.records = missing.records.filter((entry) => entry.issue_number !== 13);
  assert.match(custodyServiceErrors(matrix(), missing).join("\n"), /#13/u);
  // A shipped design with the program matrix is still one design.
  assert.ok(Object.keys(files).includes(PROGRAM_MATRIX_PATH));
  // Malformed input does not throw.
  assert.notDeepEqual(custodyServiceErrors({}, program()), []);
  assert.notDeepEqual(custodyServiceErrors(matrix(), {}), []);
});

test("the contract says who writes the project's .git and what keeps a protected ref where the helper left it (ADR-102)", () => {
  const contract = files[CONTRACT_PATH];
  assert.match(contract, /autosk-flow-ref-custody/u);
  // The withdrawn account model is gone from the contract.
  for (const withdrawn of [
    /dedicated service account/u,
    /service-owned/u,
    /service-managed/u,
    /custody owner account/u,
    /mode `3770`/u,
    /read-only gitfile/u,
    /installing user's own account no longer writes a protected ref/u,
  ]) {
    assert.doesNotMatch(contract, withdrawn);
  }
  const fiveA = contract.slice(contract.indexOf("## 5a."), contract.indexOf("## 5b."));
  for (const phrase of [
    /It runs as the installing user/u,
    /`runs_as=installing_user`, `runs_as_installing_user=true`/u,
    /`git_directory_owner=installing_user`/u,
    /no `safe\.directory` exception/u,
    /the user's porcelain works on it as on any repository/u,
    /against a model, the OS/u,
    /against the installing user's own tools, which the OS does not stop, detection, as for the target \(ADR-099\)/u,
    /`--no-replace-objects`/u,
    /withdrew the service account ADR-095 gave it, and the privileged custody install with it/u,
  ]) {
    assert.match(fiveA, phrase);
  }
  assert.match(contract, /ref_custody_unavailable/u);
  assert.ok(PARK_REASONS.includes("ref_custody_unavailable"));
});

test("§5a says what the helper is instead of §5's binaries, and what it does not cover (review M4)", () => {
  const contract = files[CONTRACT_PATH];
  const section = contract.slice(contract.indexOf("## 5a."), contract.indexOf("## 6."));
  assert.match(section, /a separately shipped executable, not one of §5's installing-user binaries/u);
  assert.match(section, /Instead of §5's checks/u);
  assert.match(section, /packaging/u);
  assert.match(section, /open for #5 and #13/u);
  assert.match(section, /ADR-023 signer boundary[^\n]*still open[^\n]*#4[^\n]*#34/u);
});

// --- debt 12a: one account model for the project's Git directory (R8-1, R8-13) --
//
// Round 8 of #39, R8-1: §5a made `autosk-flow-ref-custody` and autoskd the only
// writers of the project's `.git` and denied it to the installing user's
// account and a model's, while autoskd is one of §5's installing-user binaries
// and the model processes are its children, with no uid drop anywhere in the
// series (patch 0028's `autoskEnv`): Unix permissions are per uid, so either
// autoskd writes `.git` as the user or cannot write it, and a model process
// holds autoskd's rights either way. No record gave the model processes an
// account. R8-13: `ref_custody_unavailable` had no producer, no step, no entry
// and no doctor or preflight check.

import {
  CUSTODY_ACCOUNT_CONSTANTS,
  MODEL_ACCOUNT,
  POLICY_EXAMPLE_PATH,
  POLICY_SCHEMA_PATH,
  PROGRAM_MATRIX_PATH as PROGRAM_PATH,
  adr102PolicyProfile,
  installCheckErrors,
  modelAccountErrors,
  policyProfileErrors,
} from "../scripts/validate-platform-support.mjs";
import { validateJsonSchema } from "../scripts/validate-planning-ref-design.mjs";

/** The model account's constants, as the schema must fix them. */
const MODEL_CONSTANTS = Object.freeze({
  account: "autosk-model",
  runs_as: "dedicated_model_account",
  runs_as_installing_user: false,
  created_by: "privileged_install",
  launched_by: "autoskd",
  setuid_binary: false,
  whole_tree_termination: true,
  git_directory_writes: false,
  git_directory_reads: false,
  signer_access: false,
  secure_store_access: false,
  keychain_access: false,
  daemon_capability: false,
  checked_by: "security.model_account",
});

const program = () => JSON.parse(files[PROGRAM_PATH]);

test("model processes run in an account of their own, which the privileged install creates (R8-1)", () => {
  const record = matrix().install.model_account;
  assert.ok(record, "install.model_account");
  for (const [field, value] of Object.entries(MODEL_CONSTANTS)) assert.equal(record[field], value, field);
  assert.equal(MODEL_ACCOUNT, "autosk-model");
  assert.deepEqual(record.owner_issues, [11, 13, 18]);
  assert.deepEqual(record.writes, ["own_worktree_files", "own_provider_session"]);
  assert.deepEqual(record.launch_mechanisms, ["service_manager_unit", "sudoers_rule"]);
  assertRejects(mutated((value) => { delete value.install.model_account; }), /model_account/u);
  for (const [field, wrong] of [
    ["account", "installing_user"],
    ["runs_as", "installing_user"],
    ["runs_as_installing_user", true],
    ["created_by", "installing_user"],
    ["launched_by", "installing_user"],
    ["setuid_binary", true],
    ["whole_tree_termination", false],
    ["git_directory_writes", true],
    ["git_directory_reads", true],
    ["signer_access", true],
    ["secure_store_access", true],
    ["keychain_access", true],
    ["daemon_capability", true],
    ["checked_by", "security.signer_boundary"],
  ]) {
    assertRejects(mutated((value) => { value.install.model_account[field] = wrong; }), /model_account/u);
  }
  // A launch through a setuid binary of this project is not a mechanism the
  // record can name, and a record must name at least one.
  assertRejects(mutated((value) => { value.install.model_account.launch_mechanisms = ["setuid_binary"]; }), /model_account/u);
  assertRejects(mutated((value) => { value.install.model_account.launch_mechanisms = []; }), /model_account/u);
  assertRejects(mutated((value) => { value.install.model_account.writes = ["own_worktree_files", "project_git_directory"]; }), /model_account/u);
  assertRejects(mutated((value) => { value.install.model_account.owner_issues = [13]; }), /model_account\.owner_issues/u);
  // The constants are constants in the schema, not booleans a record could set
  // either way, as §5's prohibitions are.
  const node = schema.properties.install.properties.model_account;
  assert.equal(node.additionalProperties, false);
  for (const [field, value] of Object.entries(MODEL_CONSTANTS)) assert.equal(node.properties[field].const, value, field);
  const pinned = schema.properties.install.properties.model_account;
  const unpinned = structuredClone(schema);
  delete unpinned.properties.install.properties.model_account.properties.git_directory_writes.const;
  assert.ok(pinned.properties.git_directory_writes.const === false);
  assert.match(validatePlatformSupportDesign({ ...files, [SCHEMA_PATH]: JSON.stringify(unpinned) }).join("\n"),
    /install\.model_account\.git_directory_writes must be fixed to false/u);
  // The privileged install is the model account's own now, and all it does:
  // ADR-102 withdrew the custody service account it also created.
  const install = matrix().install.model_account.privileged_install;
  assert.equal(install.requires_administrator, true);
  assert.equal(node.properties.privileged_install.properties.requires_administrator.const, true);
  const effects = install.effects.join("\n");
  assert.equal(install.effects.length, 2);
  assert.match(effects, /creates the dedicated unprivileged model account autosk-model/u);
  assert.match(effects, /sets up the one mechanism autoskd starts model processes under autosk-model through[^\n]*never a setuid binary/u);
  assert.doesNotMatch(effects, /service account|common Git directory|ancestor/u);
  assertRejects(mutated((value) => { value.install.model_account.privileged_install.requires_administrator = false; }), /model_account/u);
});

test("autoskd runs as the installing user, and who writes the project's Git directory is stated per account (R8-1)", () => {
  const install = matrix().install;
  assert.equal(install.binaries_run_as, "installing_user");
  assert.equal(schema.properties.install.properties.binaries_run_as.const, "installing_user");
  assertRejects(mutated((value) => { value.install.binaries_run_as = "dedicated_service_account"; }), /binaries_run_as/u);
  const service = install.ref_custody_service;
  // Writers by protocol: the helper the protected paths, the installing user's
  // account everything else. `packed-refs` is no longer a protected path: the
  // user's Git writes it, and a protected entry in it is refused by the
  // helper's preflight (ADR-102).
  assert.deepEqual(service.protected_paths, ["refs/autosk/**", "logs/refs/autosk/**"]);
  assert.deepEqual(service.git_directory_writers, {
    protected_refs: ["autosk-flow-ref-custody"],
    ordinary_objects_and_refs: ["installing_user"],
  });
  // What keeps a protected ref where the helper left it: the OS against a
  // model, detection against the installing user's own tools.
  assert.deepEqual(service.protected_ref_guard, {
    model_account: "denied_by_the_os",
    installing_user_tools: "detected_at_the_helper_cas",
    packed_protected_entry: "refused_by_the_preflight",
  });
  for (const mutate of [
    (value) => { value.install.ref_custody_service.git_directory_writers.ordinary_objects_and_refs = ["installing_user", "autosk-model"]; },
    (value) => { value.install.ref_custody_service.git_directory_writers.protected_refs = ["autosk-flow-ref-custody", "installing_user"]; },
    (value) => { value.install.ref_custody_service.protected_ref_guard.installing_user_tools = "denied_by_the_os"; },
    (value) => { value.install.ref_custody_service.protected_ref_guard.model_account = "detected_at_the_helper_cas"; },
    (value) => { value.install.ref_custody_service.protected_paths = ["refs/autosk/**", "logs/refs/autosk/**", "packed-refs"]; },
    (value) => { value.install.ref_custody_service.user_account_git_writes = { protected_refs: false, ordinary_objects_and_refs: true }; },
  ]) {
    assertRejects(mutated(mutate), /ref_custody_service/u);
  }
  // The schema fixes each field of the account model, and the validator says
  // so when a schema stops fixing one.
  assert.deepEqual(CUSTODY_ACCOUNT_CONSTANTS.map(([field]) => field),
    ["runs_as", "runs_as_installing_user", "git_directory_owner", "protected_paths", "git_directory_writers", "protected_ref_guard"]);
  for (const [field, expected] of CUSTODY_ACCOUNT_CONSTANTS) {
    assert.deepEqual(schema.properties.install.properties.ref_custody_service.properties[field].const, expected, field);
    assert.deepEqual(service[field], expected, field);
    const loose = structuredClone(schema);
    delete loose.properties.install.properties.ref_custody_service.properties[field].const;
    assert.match(validatePlatformSupportDesign({ ...files, [SCHEMA_PATH]: JSON.stringify(loose) }).join("\n"),
      new RegExp(`install\\.ref_custody_service\\.${field} must be fixed to`, "u"), field);
  }
  const unpinned = structuredClone(schema);
  delete unpinned.properties.install.properties.binaries_run_as.const;
  assert.match(validatePlatformSupportDesign({ ...files, [SCHEMA_PATH]: JSON.stringify(unpinned) }).join("\n"),
    /install\.binaries_run_as must be fixed to installing_user/u);
});

test("the model account's owners are v1 records whose obligations name it (R8-1)", () => {
  // #13 the account and its launch mechanism, #11 the model process
  // environment, #18 the launch path: held to the program matrix as the
  // custody service's owners are (ADR-095).
  assert.deepEqual(modelAccountErrors(matrix(), program()), []);
  for (const issue of [11, 13, 18]) {
    const record = program().records.find((entry) => entry.issue_number === issue);
    assert.match(record.implementation_obligation_before_mvp, /`autosk-model`/u, `#${issue}`);
    const unnamed = program();
    const owner = unnamed.records.find((entry) => entry.issue_number === issue);
    owner.implementation_obligation_before_mvp = owner.implementation_obligation_before_mvp.replaceAll("`autosk-model`", "the model account");
    assert.match(modelAccountErrors(matrix(), unnamed).join("\n"), new RegExp(`model_account owner #${issue} does not name`, "u"));
    const later = program();
    later.records.find((entry) => entry.issue_number === issue).lifecycle = "planned_after_v1";
    assert.match(modelAccountErrors(matrix(), later).join("\n"), new RegExp(`model_account owner #${issue} is planned_after_v1, not required_for_v1`, "u"));
  }
  const missing = program();
  missing.records = missing.records.filter((entry) => entry.issue_number !== 18);
  assert.match(modelAccountErrors(matrix(), missing).join("\n"), /model_account owner #18 is not a record/u);
  // Malformed input does not throw.
  assert.notDeepEqual(modelAccountErrors({}, program()), []);
  assert.notDeepEqual(modelAccountErrors(matrix(), {}), []);
  // The shipped design runs the check.
  const unnamed = program();
  const owner = unnamed.records.find((entry) => entry.issue_number === 13);
  owner.implementation_obligation_before_mvp = owner.implementation_obligation_before_mvp.replaceAll("`autosk-model`", "the model account");
  assert.match(validatePlatformSupportDesign({ ...files, [PROGRAM_PATH]: JSON.stringify(unnamed) }).join("\n"), /model_account owner #13/u);
});

test("each install record names the doctor check that proves it, required where it must be (R8-1, R8-13)", () => {
  const value = matrix();
  assert.equal(value.install.model_account.checked_by, "security.model_account");
  assert.equal(value.install.ref_custody_service.checked_by, "security.ref_custody");
  // Held against the doctor's registry and the preflight's sets themselves.
  assert.deepEqual(installCheckErrors(value), []);
  // Review of 12a (M1): the custody check is held to the preflight's
  // graph-derived set (every workflow that reaches a step asking the helper),
  // no longer to the planning and delivery phases.
  const sets = {
    registered: ["security.model_account", "security.ref_custody"],
    modelStepChecks: ["security.model_account"],
    custodyStepChecks: ["security.ref_custody"],
  };
  assert.deepEqual(installCheckErrors(value, sets), []);
  assert.match(installCheckErrors(value, { ...sets, registered: ["security.ref_custody"] }).join("\n"),
    /`security\.model_account` is not a check the doctor registers/u);
  assert.match(installCheckErrors(value, { ...sets, modelStepChecks: [] }).join("\n"),
    /`security\.model_account` is not required of every model step \(MODEL_STEP_CHECKS\)/u);
  assert.match(installCheckErrors(value, { ...sets, custodyStepChecks: [] }).join("\n"),
    /`security\.ref_custody` is not required of every workflow that asks the helper \(CUSTODY_STEP_CHECKS\)/u);
  // A phase listing it is not what holds it.
  assert.match(installCheckErrors(value, { ...sets, custodyStepChecks: [], phaseChecks: { planning: ["security.ref_custody"], delivery: ["security.ref_custody"] } }).join("\n"),
    /`security\.ref_custody` is not required of every workflow that asks the helper/u);
  assert.notDeepEqual(installCheckErrors({}), []);
  assert.notDeepEqual(installCheckErrors(value, {}), []);
});

test("the contract states the account model: autoskd's, the helper's and the model's (R8-1)", () => {
  const contract = files[CONTRACT_PATH];
  const five = contract.slice(contract.indexOf("## 5. "), contract.indexOf("## 5a."));
  assert.match(five, /`binaries_run_as=installing_user`/u);
  assert.ok(contract.indexOf("## 5b.") > contract.indexOf("## 5a."), "§5b follows §5a");
  const fiveA = contract.slice(contract.indexOf("## 5a."), contract.indexOf("## 5b."));
  assert.doesNotMatch(fiveA, /only `autosk-flow-ref-custody` and autoskd/u);
  // Fix round 2: the OS no longer keeps the installing user's account off a
  // protected ref; detection does (was: "no longer writes a protected ref").
  assert.doesNotMatch(fiveA, /installing user's own account no longer writes a protected ref/u);
  assert.match(fiveA, /the principal/u);
  assert.match(fiveA, /foreign movement/u);
  const fiveB = contract.slice(contract.indexOf("## 5b."), contract.indexOf("## 6."));
  assert.match(fiveB, /`autosk-model`/u);
  assert.match(fiveB, /never a setuid or setgid binary of this project/u);
  assert.match(fiveB, /no Git directory of the project/u);
  for (const word of [/signer/u, /secure store/u, /keychain/u, /ptrace/u, /`AUTOSK_SESSION_TOKEN`/u, /model sandbox/u, /`security\.model_account`/u, /#197/u]) {
    assert.match(fiveB, word);
  }
  for (const issue of [11, 13, 18]) assert.match(fiveB, new RegExp(`#${issue}\\b`, "u"));
  // What another uid does and does not keep from the model: the user's
  // keychain and owner-only files, not what the user left readable to all.
  assert.doesNotMatch(fiveB, /reaches none of the installing user's keychain or home/u);
  assert.match(fiveB, /inherits neither the installing user's keychain nor any file only that user may read/u);
  assert.match(fiveB, /a model process reads what every account may read — a file the user left readable to all/u);
  assert.match(fiveB, /Where each model's worktree and session directory lie[^\n]*is open for #13 with #18 and #11/u);
  const tests = contract.slice(contract.indexOf("## 8."), contract.indexOf("## 9."));
  assert.match(tests, /model account/u);
  assert.match(contract.slice(contract.indexOf("## 9.")), /§5b/u);
  // The validator reads the contract for the account too.
  const stripped = contract.replaceAll("`autosk-model`", "the model account");
  assert.match(validatePlatformSupportDesign({ ...files, [CONTRACT_PATH]: stripped }).join("\n"), /does not name the model account `autosk-model`/u);
});

test("ref_custody_unavailable has a named evaluator and an owner, and §7 says no reason is produced yet (R8-13)", () => {
  const contract = files[CONTRACT_PATH];
  const fiveA = contract.slice(contract.indexOf("## 5a."), contract.indexOf("## 5b."));
  assert.match(fiveA, /`security\.ref_custody`/u);
  assert.match(fiveA, /`ref_custody_unavailable`[^\n]*#13/u);
  const seven = contract.slice(contract.indexOf("## 7."), contract.indexOf("## 8."));
  assert.match(seven, /None of these reasons has a producer yet/u);
  assert.match(seven, /`security\.ref_custody`/u);
});

test("no document still says the installing user's account cannot write the project's Git directory (R8-1)", () => {
  const read = (relative) => readFileSync(path.join(ROOT, relative), "utf8");
  const architecture = read("02-architecture.md");
  assert.doesNotMatch(architecture, /Project\/model accounts cannot open either Git directory/u);
  // Fix round 2: the model account opens neither Git directory at all (was:
  // "for writes").
  assert.match(architecture, /The model account `autosk-model` cannot open either Git directory, for reads or for writes/u);
  assert.doesNotMatch(architecture, /project\/model accounts cannot run maintenance/iu);
  const pi = architecture.slice(architecture.indexOf("### Pi-провайдеры"), architecture.indexOf("### Git"));
  assert.match(pi, /`autosk-model`[^\n]*#13/u);
  const planning = read("docs/contracts/epic-planning-ref.md");
  assert.doesNotMatch(planning, /Project\/model accounts cannot run maintenance/u);
  assert.doesNotMatch(planning, /non-writable by project\/model accounts/u);
  assert.match(planning, /the model account `autosk-model`, which every model process runs under, opens no Git directory of the project/u);
  // Obligation 39 names the accounts it proves (was: "extension/model/project accounts").
  assert.doesNotMatch(planning, /fail from extension\/model\/project accounts/u);
  assert.match(planning, /fail from the model account, and a direct write from the installing user's account/u);
  const readme = read("README.md");
  const rule = readme.split("\n").find((line) => line.startsWith("19. ")) ?? "";
  assert.doesNotMatch(rule, /учётная запись пользователя и модели не пишет в `\.git` проекта напрямую/u);
  assert.match(rule, /`autosk-model`/u);
  assert.match(rule, /обязательство #13/u);
  // Fix round 2 (ADR-102): no document keeps the withdrawn custody account,
  // the service-owned Git directory or the read-only gitfile.
  const withdrawn = [/service-owned/u, /service-managed/u, /separate-account/u, /dedicated service account/u, /read-only gitfile/u, /Privileged bootstrap/u, /custody owner account/u];
  for (const [relative, text] of [
    ["02-architecture.md", architecture],
    ["03-technical-plan.md", read("03-technical-plan.md")],
    ["docs/contracts/epic-planning-ref.md", planning],
    ["docs/contracts/epic-staging.md", read("docs/contracts/epic-staging.md")],
    ["README.md rule 19", rule],
  ]) {
    for (const phrase of withdrawn) assert.doesNotMatch(text, phrase, `${relative}: ${phrase}`);
  }
  assert.doesNotMatch(rule, /Отдельная служебная учётная запись/u);
  assert.match(rule, /работает под учётной записью пользователя/u);
  assert.doesNotMatch(read("docs/contracts/epic-staging.md"), /from the extension, model or project account fails/u);
  const plan = read("03-technical-plan.md");
  assert.match(plan, /Model sandbox[^\n]*`autosk-model`/u);
  const own13 = program().records.find((entry) => entry.issue_number === 13).implementation_obligation_before_mvp;
  assert.doesNotMatch(own13, /no direct write to the project's \.git/u);
  const decisions = read("04-decisions.md");
  assert.match(decisions, /^## ADR-102: /mu);
  const adr095 = decisions.slice(decisions.indexOf("## ADR-095:"), decisions.indexOf("## ADR-096:"));
  assert.match(adr095, /^- Изменено ADR-102: /mu);
  // ADR-023's "sandbox profile" is the model account now.
  const adr023 = decisions.slice(decisions.indexOf("## ADR-023:"), decisions.indexOf("## ADR-024:"));
  assert.match(adr023, /^- Изменено ADR-102: [^\n]*`autosk-model`/mu);
});

// Narrow re-review of 0ea81de (H1, Lows 7, 8 and 10): 0ea81de's `3770`
// topology was one half of a Git directory two accounts write, which ADR-102
// withdrew. The policy schema admits the ADR-102 profile instead — the helper
// runs as the installing user, the Git directory is the user's and closed to
// every other account, and the permission probes' `project-account` is the
// model account — while the committed example, which the signed goldens bind
// through its digest, stays valid. The validator holds both, and refuses a
// policy that mixes them.
test("the ref-custody policy admits the ADR-102 profile beside the example the signed goldens bind (narrow re-review H1, Lows 7, 8, 10)", () => {
  const policy = JSON.parse(files[POLICY_SCHEMA_PATH]);
  const example = JSON.parse(files[POLICY_EXAMPLE_PATH]);
  // 0ea81de's topology is undone: owner-only Git directory modes again.
  const profile = policy.$defs.platform_profile.properties;
  assert.deepEqual(profile.common_git_dir_mode_octal, { const: "0700" });
  assert.deepEqual(profile.per_worktree_git_dir_mode_octal, { const: "0700" });
  assert.deepEqual(policy.$defs.topology_entry.properties.mode_octal, { enum: ["0700", "0750"] });
  assert.ok(!JSON.stringify(policy).includes("3770"));
  // The example is unchanged and valid, and so is its ADR-102 form.
  assert.equal(example.policy_digest, "a9802252ce8dbef830d3db84187e3d96741df3f38c4cd29587d44c7fb98df6ab");
  assert.equal(Object.hasOwn(example, "helper_runs_as"), false);
  assert.deepEqual(validateJsonSchema(example, policy, policy), []);
  const adr102 = adr102PolicyProfile(example);
  assert.equal(adr102.helper_runs_as, "installing-user");
  assert.ok(adr102.supported_platforms.every((entry) => entry.helper_account === "installing-user"
    && entry.owner_account === "installing-user" && entry.gitfile_read_only === false));
  assert.equal(adr102.packed_refs_policy.maintenance_owner, "installing-user");
  assert.deepEqual(adr102.parent_topology.map((entry) => [entry.path_role, entry.mode_octal]), [["project-common-git-dir", "0700"]]);
  assert.deepEqual(validateJsonSchema(adr102, policy, policy), []);
  assert.deepEqual(policyProfileErrors(policy, example), []);
  // The probes keep their actor and their denials; under ADR-102 the actor is
  // the model account.
  assert.deepEqual(policy.$defs.permission_probe.properties.actor, { const: "project-account" });
  assert.deepEqual(policy.$defs.permission_probe.properties.result, { const: "denied" });
  // A policy that mixes the two is refused, both ways.
  for (const mutate of [
    (value) => { value.supported_platforms[0].helper_account = "autosk-ref-custody"; },
    (value) => { value.supported_platforms[1].owner_account = "autosk-custody"; },
    (value) => { value.supported_platforms[0].gitfile_read_only = true; },
    (value) => { value.packed_refs_policy.maintenance_owner = "autosk-custody"; },
    (value) => { value.parent_topology = structuredClone(example.parent_topology); },
    (value) => { value.parent_topology[0].mode_octal = "0750"; },
  ]) {
    const value = structuredClone(adr102);
    mutate(value);
    assert.notDeepEqual(validateJsonSchema(value, policy, policy), [], String(mutate));
  }
  for (const mutate of [
    (value) => { value.supported_platforms[0].helper_account = "installing-user"; },
    (value) => { value.packed_refs_policy.maintenance_owner = "installing-user"; },
    (value) => { value.parent_topology = value.parent_topology.slice(1); },
  ]) {
    const value = structuredClone(example);
    mutate(value);
    assert.notDeepEqual(validateJsonSchema(value, policy, policy), [], String(mutate));
  }
  // The validator says so when the schema stops admitting either, or admits a mix.
  const noProfile = structuredClone(policy);
  delete noProfile.properties.helper_runs_as;
  assert.match(policyProfileErrors(noProfile, example).join("\n"), /does not admit the ADR-102 profile/u);
  assert.match(validatePlatformSupportDesign({ ...files, [POLICY_SCHEMA_PATH]: JSON.stringify(noProfile) }).join("\n"),
    /does not admit the ADR-102 profile/u);
  const noLegacy = structuredClone(policy);
  noLegacy.$defs.platform_profile.properties.helper_account = { const: "installing-user" };
  assert.match(policyProfileErrors(noLegacy, example).join("\n"), /does not admit the committed example/u);
  const mixing = structuredClone(policy);
  mixing.allOf = mixing.allOf.filter((branch) => !(branch.if?.required ?? []).includes("helper_runs_as"));
  assert.match(policyProfileErrors(mixing, example).join("\n"), /admits a policy that mixes/u);
  assert.notDeepEqual(policyProfileErrors({}, example), []);
  assert.notDeepEqual(policyProfileErrors(policy, {}), []);
  // §5a says what the example is and what the ADR-102 profile is, without the
  // wrong reason round one gave.
  const contract = files[CONTRACT_PATH];
  const fiveA = contract.slice(contract.indexOf("## 5a."), contract.indexOf("## 5b."));
  assert.doesNotMatch(fiveA, /a change to the policy moves its digest/u);
  for (const phrase of [
    /`helper_runs_as=installing-user`/u,
    /The committed example has no `helper_runs_as`: it predates ADR-102/u,
    /it changes only when #5 signs those goldens again/u,
    /signed by the daemon key the example binds, whose private key is not in this repository/u,
    /`project-account`, which under this profile is the model account/u,
  ]) {
    assert.match(fiveA, phrase);
  }
  // Nor does any decision keep the wrong reason: the schema is not what
  // `policy_digest` is over.
  const decisions = readFileSync(path.join(ROOT, "04-decisions.md"), "utf8");
  const adr095 = decisions.slice(decisions.indexOf("## ADR-095:"), decisions.indexOf("## ADR-096:"));
  assert.doesNotMatch(adr095, /их смена сдвигает `policy_digest`/u);
  const adr102text = decisions.slice(decisions.indexOf("## ADR-102:"), decisions.indexOf("## Оставшиеся риски"));
  assert.doesNotMatch(adr102text, /Изменить режимы значит сдвинуть `policy_digest`/u);
  assert.match(adr102text, /`policy_digest` считается по примеру, а не по схеме/u);
});

// --- review of 12a on 9b65ad3: M2, M3, M4, L1–L4 ---------------------------------

const read = (relative) => readFileSync(path.join(ROOT, relative), "utf8");
const sectionOf = (text, from, to) => text.slice(text.indexOf(from), text.indexOf(to));

// M3: autoskd cannot signal a process of another uid (kill(2) needs the same
// uid or CAP_KILL), and a sudoers rule relays a signal only to the command it
// started, so "a timeout kills the whole process tree, no orphan survives"
// (provider-preflight §4) holds for a model process only through the launch
// mechanism.
test("a model process tree is stopped whole through the launch mechanism, since autoskd cannot signal another uid (review M3)", () => {
  assert.equal(matrix().install.model_account.whole_tree_termination, true);
  assert.equal(schema.properties.install.properties.model_account.properties.whole_tree_termination.const, true);
  assertRejects(mutated((value) => { delete value.install.model_account.whole_tree_termination; }), /model_account/u);
  const loose = structuredClone(schema);
  delete loose.properties.install.properties.model_account.properties.whole_tree_termination.const;
  assert.match(validatePlatformSupportDesign({ ...files, [SCHEMA_PATH]: JSON.stringify(loose) }).join("\n"),
    /install\.model_account\.whole_tree_termination must be fixed to true/u);
  const contract = files[CONTRACT_PATH];
  const fiveB = sectionOf(contract, "## 5b.", "## 6.");
  for (const phrase of [
    /`kill\(2\)` needs the same uid or `CAP_KILL`/u,
    /`whole_tree_termination=true`/u,
    /`docs\/contracts\/provider-preflight\.md` §4/u,
    /A service-manager unit whose control group the manager kills as a whole satisfies it/u,
    // Narrow re-review, Low 12: measured with this host's `Defaults use_pty`.
    /A sudoers rule alone does not: measured with sudo 1\.9\.15p5 under `Defaults use_pty`, a SIGTERM to sudo ended the command it started, while a background child in the command's process group and a descendant that called `setsid` kept running/u,
    /a single supervisor under the model account/u,
  ]) {
    assert.match(fiveB, phrase);
  }
  assert.match(sectionOf(contract, "## 8.", "## 9."), /killed whole on a timeout through the launch mechanism/u);
  assert.match(read("docs/contracts/provider-preflight.md"), /a timeout kills the whole \*\*process tree\*\*/u);
});

// M2: 02 §5 put provider sessions under `.autosk/autosk-flow/provider-sessions/`,
// the store accepts a file there only when it is private to autoskd's uid, and
// README rule 16 keeps `.autosk` from model sessions; a model account cannot
// write a session there.
test("a model's provider session and runtime HOME live in a directory of its own outside .autosk, read by autoskd as untrusted input (review M2)", () => {
  const fiveB = sectionOf(files[CONTRACT_PATH], "## 5b.", "## 6.");
  assert.doesNotMatch(fiveB, /its own provider session \(02 §6\)/u);
  for (const phrase of [
    /a session directory of its own that holds its provider session and each runtime's `HOME` and configuration/u,
    /nothing under `\.autosk`, whose store accepts a file only when it is private to autoskd's uid/u,
    /README rule 16 keeps from model sessions/u,
    /untrusted input, parsed and copied, never adopted into autoskd's store as its own file/u,
    /is open for #13 with #18 and #11/u,
  ]) {
    assert.match(fiveB, phrase);
  }
  const rule16 = read("README.md").split("\n").find((line) => line.startsWith("16. ")) ?? "";
  assert.match(rule16, /сессия провайдера[^\n]*вне `\.autosk`/u);
  const six = sectionOf(read("02-architecture.md"), "## 6. ", "## 7. ");
  assert.match(six, /учётн[^\n]*`autosk-model`[^\n]*вне `\.autosk`/u);
  const adr = sectionOf(read("04-decisions.md"), "## ADR-102:", "## Оставшиеся риски");
  assert.doesNotMatch(adr, /сессия провайдера — файлы, которые учётная запись может писать/u);
});

// M4: the worktree root is the model account's to write, so a gitfile it
// replaces would redirect a Git command that discovers the repository from it.
test("autoskd never discovers a repository from a directory a model can write, and runs model-written code only under the model account (review M4)", () => {
  const contract = files[CONTRACT_PATH];
  const fiveB = sectionOf(contract, "## 5b.", "## 6.");
  for (const phrase of [
    /autoskd never discovers a repository from a directory the model account can write/u,
    /names the per-worktree Git directory and the work tree \(`--git-dir`, `--work-tree`\)/u,
    /`-c core\.hooksPath=\/dev\/null -c core\.fsmonitor=false -c diff\.ignoreSubmodules=all`/u,
    /inherits no Git variable/u,
    /An explicit `--git-dir` skips that ownership check/u,
    /never a `safe\.directory` exception for a model worktree, `\*` least of all/u,
    /`config\.worktree` pins `core\.hooksPath=\/dev\/null` and `core\.fsmonitor=false`/u,
    /`safe\.bareRepository=explicit` refuses it/u,
    /can replace its worktree's gitfile/u,
    /aggregate verification's checks among them[^\n]*runs under the model account like a model step, never as the installing user/u,
    /The aggregate driver already holds the rule for its throwaway checkout[^\n]*runs no Git command from inside the checkout \(`checkoutStaging`\)/u,
  ]) {
    assert.match(fiveB, phrase);
  }
  assert.match(sectionOf(contract, "## 8.", "## 9."), /never followed by a Git command autoskd runs, and no hook or fsmonitor of the planted repository running/u);
  const records = program().records;
  const obligation = (issue) => records.find((entry) => entry.issue_number === issue).implementation_obligation_before_mvp;
  assert.match(obligation(18), /with the per-worktree Git directory and the work tree named explicitly and hooks, fsmonitor and submodule recursion off/u);
  assert.match(obligation(18), /every check that runs code a model wrote/u);
  assert.doesNotMatch(obligation(13), /custody-owned/u);
  assert.match(obligation(13), /no `safe\.directory` exception/u);
  assert.match(obligation(18), /config\.worktree/u);
  const readme = read("README.md");
  assert.match(readme, /safe\.bareRepository=explicit/u);
  assert.match(readme, /safe\.directory/u);
  assert.match(obligation(9), /under the model account/u);
});

// L1 of the first review, and Medium 5 and 6 of the narrow re-review, fall
// away with the user-owned repository: the installing user's porcelain —
// deleting branches and tags, `git config`, `fetch --prune`, `gc` — works on
// its own repository (measured with Git 2.43), so no deletion limit, no
// closed config, hooks or info, and no ownership after a migration is left to
// state.
test("the installing user's porcelain works on its own repository, so round one's deletion limit falls away (narrow re-review Medium 5, 6)", () => {
  const contract = files[CONTRACT_PATH];
  const fiveA = sectionOf(contract, "## 5a.", "## 5b.");
  assert.doesNotMatch(fiveA, /cannot delete an ordinary branch or tag/u);
  assert.doesNotMatch(fiveA, /Which account deletes an ordinary ref/u);
  assert.match(fiveA, /deleting branches and tags, `git config`, hooks, `fetch --prune`, `gc` \(measured with Git 2\.43\)/u);
  const tests = sectionOf(contract, "## 8.", "## 9.");
  assert.doesNotMatch(tests, /deleting an ordinary branch or tag from the installing user's account after the install/u);
  assert.match(tests, /the installing user's porcelain — branch and tag deletion, `git config`, `fetch --prune`, `gc` — working on the project's Git directory after the bootstrap/u);
  const rule = read("README.md").split("\n").find((line) => line.startsWith("19. ")) ?? "";
  assert.doesNotMatch(rule, /Удалить ветку или тег напрямую она не может/u);
});

// L2: upstream autoskd listens on TCP (`0.0.0.0:7077` without `--tcp`) with an
// RPC token file, so "cannot do by another route" holds only if the model
// account cannot read the token and the listener is loopback.
test("the model account cannot use autoskd's RPC: the token is the installing user's and the listener loopback, and the probe proves both (review L2)", () => {
  const contract = files[CONTRACT_PATH];
  const fiveB = sectionOf(contract, "## 5b.", "## 6.");
  for (const phrase of [
    /`~\/\.autosk\/daemon-token`, `0600`/u,
    /its TCP listener binds loopback only/u,
    /`0\.0\.0\.0:7077`/u,
    /cannot read autoskd's RPC token and finds autoskd's TCP listener, where there is one, only on loopback/u,
  ]) {
    assert.match(fiveB, phrase);
  }
  assert.match(sectionOf(contract, "## 8.", "## 9."), /to read autoskd's RPC token/u);
  assert.match(sectionOf(contract, "## 8.", "## 9."), /only on loopback/u);
  const own13 = program().records.find((entry) => entry.issue_number === 13).implementation_obligation_before_mvp;
  assert.match(own13, /cannot read autoskd's RPC token/u);
});

// L3: the older names, mapped once in §5a (fix round 2: the policy probes'
// `project-account` is the model account, and the example's `helper_account`
// and `owner_account` are the service accounts ADR-102 withdrew).
test("the older account names map onto the accounts of ADR-102 (review L3, narrow re-review)", () => {
  const fiveA = sectionOf(files[CONTRACT_PATH], "## 5a.", "## 5b.");
  for (const phrase of [
    /The ref-custody policy's `project-account` is the model account/u,
    /its `helper_account` and `owner_account`, in the committed example, are the service accounts ADR-102 withdrew/u,
    /the extension runs inside autoskd, in the installing user's account/u,
  ]) {
    assert.match(fiveA, phrase);
  }
  assert.doesNotMatch(fiveA, /The installing user's account is what the ref-custody policy's probes call `project-account`/u);
  const policy = JSON.parse(files[POLICY_SCHEMA_PATH]);
  assert.deepEqual(policy.$defs.permission_probe.properties.actor, { const: "project-account" });
  // The contracts that said "extension/model/project accounts" name them.
  assert.doesNotMatch(read("docs/contracts/epic-planning-ref.md"), /extension\/model\/project accounts/u);
  assert.doesNotMatch(read("docs/contracts/epic-staging.md"), /extension, model or project account/u);
  assert.match(read("docs/contracts/epic-staging.md"), /a direct write to the staging ref from the model account fails/u);
});

// Fix round 2: what keeps a protected ref where the helper left it, against
// the installing user's own tools, is detection — and each stop §5a names for
// it is a stop the graph has, so a move parks with a way back.
test("a protected ref moved outside the helper parks under a stop the graph has, and the one without a row is named (ADR-102, ADR-099)", () => {
  const fiveA = sectionOf(files[CONTRACT_PATH], "## 5a.", "## 5b.");
  const graph = JSON.parse(read("resources/workflow-graph/workflow-graph.v1.json"));
  const rows = new Map(graph.recovery.map((row) => [row.reason, row]));
  for (const [code, step] of [
    ["planning_ref_foreign_movement", "publish_artifact_pass"],
    ["planning_candidate_keepalive_invalid", "freeze_artifact"],
    ["receipt_missing", "apply_staging"],
    ["staging_moved_after_pass", "aggregate_verify"],
    ["planning_ref_capability_missing", "apply_staging"],
    ["foreign_movement", "integration_recovery"],
  ]) {
    assert.match(fiveA, new RegExp(`\`${code}\``, "u"), code);
    assert.ok(rows.get(code)?.parks_at.includes(step), `${code} parks at ${step}`);
  }
  assert.match(fiveA, /`packed_refs_drift`/u);
  assert.match(fiveA, /`git pack-refs --all` writes one even with `gc\.packRefs=false` \(measured\)/u);
  // The stop that had no row (12a) is receipt_missing's, moved behind the base, and the driver's own name is no stop (debt 12g).
  assert.ok(!rows.has("foreign_ref_movement"));
  assert.match(fiveA, /`receipt_missing`[^\n]*moved `behind` the base[^\n]*`foreign_ref_movement`[^\n]*is not a stop of the graph/u);
  assert.doesNotMatch(fiveA, /debt 12g's \(R8-9's missing edge\) with #18/u);
});

// L4: what another uid does not isolate.
test("what one shared model uid does not isolate is named (review L4)", () => {
  const fiveB = sectionOf(files[CONTRACT_PATH], "## 5b.", "## 6.");
  for (const phrase of [
    /the command line of every process in `\/proc` unless `\/proc` is mounted with `hidepid`/u,
    /a shared `\/tmp`/u,
    /one model process can signal or ptrace another/u,
    /#197/u,
  ]) {
    assert.match(fiveB, phrase);
  }
});

// --- debt 13b (round 9 of #39, R9-1): a Git view for checks and model steps ---

import * as viewValidator from "../scripts/validate-platform-support.mjs";

const GIT_VIEW_FIELDS = Object.freeze({
  built_by: "launch_under_model_account",
  at: "checkout_root",
  owned_by: "model_account",
  made_from: "handout_pack_written_by_autoskd",
  holds: "handed_commit_and_line_to_base",
  other_refs_reflogs_or_project_config: false,
  git_directory_variable_in_environment: false,
  safe_directory: "model_account_own_configuration",
  read_by_autoskd: false,
  read_by_helper: false,
  installing_user_git: "refused_as_dubious_ownership",
  covers: ["model_step", "check_running_project_code"],
  teardown: "under_model_account_then_worktree_prune",
});

test("the model account's Git view is a repository it owns at the checkout's root, built at launch from what autoskd hands over, and nothing trusts it (R9-1)", () => {
  const record = matrix().install.model_account.git_view;
  assert.ok(record, "install.model_account.git_view");
  assert.deepEqual(record.owner_issues, [9, 13, 18]);
  const { owner_issues: _owners, ...constants } = record;
  assert.deepEqual(constants, GIT_VIEW_FIELDS);
  // The validator's own list is the record's, and the account still opens no Git directory of the project.
  assert.deepEqual(Object.fromEntries(viewValidator.GIT_VIEW_CONSTANTS ?? []), GIT_VIEW_FIELDS);
  assert.equal(matrix().install.model_account.git_directory_reads, false);
  assert.equal(matrix().install.model_account.git_directory_writes, false);
  // Each field is a constant in the schema, the record is closed, and a wrong value or an extra field is refused.
  const node = schema.properties.install.properties.model_account.properties.git_view;
  assert.equal(node?.additionalProperties, false);
  assert.ok(schema.properties.install.properties.model_account.required.includes("git_view"));
  for (const [field, expected] of Object.entries(GIT_VIEW_FIELDS)) {
    assert.deepEqual(node?.properties?.[field]?.const, expected, field);
    const wrong = typeof expected === "boolean" ? !expected : Array.isArray(expected) ? [...expected, "project_git_directory"] : "something_else";
    assertRejects(mutated((value) => { value.install.model_account.git_view[field] = wrong; }), /git_view/u);
    const loose = structuredClone(schema);
    delete loose.properties.install.properties.model_account.properties.git_view.properties[field].const;
    assert.match(validatePlatformSupportDesign({ ...files, [SCHEMA_PATH]: JSON.stringify(loose) }).join("\n"),
      new RegExp(`install\\.model_account\\.git_view\\.${field} must be fixed to`, "u"), field);
  }
  assertRejects(mutated((value) => { delete value.install.model_account.git_view; }), /git_view/u);
  assertRejects(mutated((value) => { value.install.model_account.git_view.alternates_into_the_project = true; }), /git_view/u);
  assert.match(viewValidator.gitViewErrors(mutated((value) => { value.install.model_account.git_view.owner_issues = [13, 18]; }), program()).join("\n"), /git_view\.owner_issues/u);
  const open = structuredClone(schema);
  open.properties.install.properties.model_account.properties.git_view.additionalProperties = true;
  assert.match(validatePlatformSupportDesign({ ...files, [SCHEMA_PATH]: JSON.stringify(open) }).join("\n"), /install\.model_account\.git_view must be closed/u);
});

test("the Git view's owners are v1 records whose obligations name it (R9-1)", () => {
  // #18 builds it in the launch path, #9 hands it to aggregate verification's checks, #13 proves it: held to the
  // program matrix as the model account's owners are.
  assert.deepEqual(viewValidator.gitViewErrors?.(matrix(), program()), []);
  assert.deepEqual(viewValidator.GIT_VIEW_OWNERS, [9, 13, 18]);
  for (const issue of [9, 13, 18]) {
    const record = program().records.find((entry) => entry.issue_number === issue);
    assert.match(record.implementation_obligation_before_mvp, /`git_view`/u, `#${issue}`);
    const unnamed = program();
    const owner = unnamed.records.find((entry) => entry.issue_number === issue);
    owner.implementation_obligation_before_mvp = owner.implementation_obligation_before_mvp.replaceAll("`git_view`", "the view");
    assert.match(viewValidator.gitViewErrors(matrix(), unnamed).join("\n"), new RegExp(`git_view owner #${issue} does not name`, "u"));
    const later = program();
    later.records.find((entry) => entry.issue_number === issue).lifecycle = "planned_after_v1";
    assert.match(viewValidator.gitViewErrors(matrix(), later).join("\n"), new RegExp(`git_view owner #${issue} is planned_after_v1, not required_for_v1`, "u"));
  }
  const missing = program();
  missing.records = missing.records.filter((entry) => entry.issue_number !== 9);
  assert.match(viewValidator.gitViewErrors(matrix(), missing).join("\n"), /git_view owner #9 is not a record/u);
  assert.notDeepEqual(viewValidator.gitViewErrors({}, program()), []);
  assert.notDeepEqual(viewValidator.gitViewErrors(matrix(), {}), []);
  // The shipped design runs the check.
  const unnamed = program();
  const owner = unnamed.records.find((entry) => entry.issue_number === 18);
  owner.implementation_obligation_before_mvp = owner.implementation_obligation_before_mvp.replaceAll("`git_view`", "the view");
  assert.match(validatePlatformSupportDesign({ ...files, [PROGRAM_PATH]: JSON.stringify(unnamed) }).join("\n"), /git_view owner #18/u);
});

test("§5b says how the Git view is built, what it holds, who never reads it, and what the installing user's Git does in it (R9-1)", () => {
  const contract = files[CONTRACT_PATH];
  const fiveB = sectionOf(contract, "## 5b.", "## 6.");
  for (const phrase of [
    /\*\*its Git view\*\*/u,
    /`git_view`/u,
    /a repository of its own at the checkout's root, which the launch builds under the account/u,
    /a pack of the handed commit and its line down to a base[^\n]*written by autoskd, as the installing user, into a directory it names/u,
    /`git rev-parse HEAD` names the commit the launch hands over/u,
    /`git status`, `git diff` and `git ls-files` reflect the checkout's files/u,
    /aligns the index/u,
    /no other ref, no reflog of the project, no configuration of the project and no object of another line/u,
    /no `GIT_DIR` and no `GIT_WORK_TREE` in its environment/u,
    /`safe\.directory` for the checkout in the model account's own configuration, never the installing user's/u,
    /autoskd never reads it, and the helper never does/u,
    /the installing user's Git refuses it as dubious ownership/u,
    /`git worktree remove` refuses a checkout whose `\.git` is a directory/u,
    /removes a model worktree under the model account and prunes it/u,
    /a commit outside the staging line is refused/u,
  ]) {
    assert.match(fiveB, phrase);
  }
  // The measured refusals of the installing user's porcelain, restated for the view.
  assert.match(fiveB, /the installing user's Git in a model worktree refuses every command with `detected dubious ownership`[^\n]*`--git-dir=<per-worktree Git directory> --work-tree=<checkout>`/u);
  // The check paragraph says a check runs in the view, not in a checkout with no Git.
  assert.match(fiveB, /a check that runs the project's own code[^\n]*runs in the checkout's Git view/u);
  // The sentence the finding is about is gone.
  assert.doesNotMatch(fiveB, /so its own `git` in its worktree finds no repository \(measured\)/u);
  assert.doesNotMatch(fiveB, /The installing user's own Git needs no `safe\.directory` exception: a model worktree's root, gitfile and administrative directory are the installing user's, so the user's Git discovers the worktree/u);
  // What is not carried is named.
  assert.match(fiveB, /`core\.autocrlf=true`[^\n]*status is not clean/u);
  const tests = sectionOf(contract, "## 8.", "## 9.");
  assert.match(tests, /`git rev-parse HEAD` in a model step's worktree and in a check's checkout naming the commit the launch hands over/u);
  assert.match(tests, /a repository a check makes in a temporary directory being its own/u);
  assert.match(tests, /the installing user's Git refusing the model worktree's view as dubious ownership/u);
  assert.match(tests, /a view holding no ref but `HEAD`/u);
});

test("the obligations name who builds, hands over and proves the Git view (R9-1)", () => {
  const records = program().records;
  const obligation = (issue) => records.find((entry) => entry.issue_number === issue).implementation_obligation_before_mvp;
  const expectation = (issue) => records.find((entry) => entry.issue_number === issue).verification_expectation;
  assert.match(obligation(18), /builds the model account's Git view \(`git_view`\)[^.]*for every model step and every check that runs code a model wrote/u);
  assert.match(obligation(18), /from the handout `handOutGitView` writes/u);
  assert.match(obligation(9), /hands the checks the handout of the staging commit and its line down to the recorded target base \(`git_view`, `handOutGitView`\)/u);
  assert.match(obligation(13), /the model account probe proves[^.]*its Git view \(`git_view`\)/u);
  assert.match(expectation(13), /Git view/u);
  assert.match(expectation(18), /Git view/u);
  assert.match(expectation(9), /Git view/u);
});

test("README, 02 and 03 say a model works in a Git view of its own, and not that it has no Git (R9-1)", () => {
  assert.match(read("README.md"), /`git_view`, ADR-110/u);
  assert.match(read("README.md"), /`detected dubious ownership`/u);
  assert.match(read("README.md"), /`safe\.directory` для него не добавляйте/u);
  assert.match(read("02-architecture.md"), /Git-вид `git_view` \(ADR-110\)/u);
  assert.match(read("03-technical-plan.md"), /works in a Git view of its own[^\n]*\(`git_view`, ADR-110\)/u);
  assert.match(read("docs/contracts/epic-planning-ref.md"), /works in a Git view of its own that holds nothing of the project's refs/u);
});

test("ADR-110 records the decision, and ADR-102's Git text says it changed (R9-1)", () => {
  const decisions = read("04-decisions.md");
  assert.ok(decisions.includes("## ADR-110:"), "ADR-110");
  const adr = decisions.slice(decisions.indexOf("## ADR-110:"));
  for (const phrase of [/R9-1/u, /Альтернатива/u, /pack/u, /`safe\.directory`/u, /GIT_DIR/u, /--shared/u, /synthetic|синтетическ/u, /`git_view`/u, /Что не сделано/u, /Ожидания, изменённые решением/u]) {
    assert.match(adr, phrase);
  }
  const adr102 = sectionOf(decisions, "## ADR-102:", "## ADR-103:");
  assert.match(adr102, /Изменено ADR-110/u);
});

// --- debt 13c (round 9 of #39, R9-2, R9-8, R9-6): what the one model account isolates, and where it works ---

const PROCESS_ISOLATION_FIELDS = Object.freeze({
  between_model_processes: "not_isolated_by_the_os",
  kept_from_the_account: ["installing_user", "project_git_directory"],
  held_by_v1: ["separate_worktrees_and_sessions", "content_contamination_refused", "whole_tree_termination"],
  os_isolation_owner_issue: 197,
  finished_step_roots: "closed_by_autoskd_at_step_end",
  closed_root_mode: "0700",
  helps: "later_processes",
  does_not_help: ["concurrent_processes"],
});

test("the account's record says one uid does not isolate model processes from each other, and #197 owns the rest (R9-2)", () => {
  const record = matrix().install.model_account.process_isolation;
  assert.ok(record, "install.model_account.process_isolation");
  assert.deepEqual(record.owner_issues, [13, 18]);
  for (const [field, expected] of Object.entries(PROCESS_ISOLATION_FIELDS)) {
    assert.deepEqual(record[field], expected, field);
    assert.deepEqual(schema.properties.install.properties.model_account.properties.process_isolation.properties[field].const, expected, `schema ${field}`);
  }
  assert.deepEqual(viewValidator.processIsolationErrors(matrix(), program()), []);
  // A record that says the daemon isolates them, or that closing helps a concurrent process, is refused.
  for (const [field, lie] of [
    ["between_model_processes", "isolated_by_the_daemon"],
    ["does_not_help", []],
    ["os_isolation_owner_issue", 18],
    ["held_by_v1", ["separate_worktrees_and_sessions", "os_isolation"]],
  ]) {
    const bad = matrix();
    bad.install.model_account.process_isolation[field] = lie;
    assert.match(viewValidator.processIsolationErrors(bad, program()).join("\n"), new RegExp(`process_isolation\\.${field} must be`, "u"), field);
    assertRejects(bad, new RegExp(`process_isolation\\.${field}`, "u"));
  }
  // Its owners are v1 records that name it.
  const noName = program();
  const own18 = noName.records.find((entry) => entry.issue_number === 18);
  own18.implementation_obligation_before_mvp = own18.implementation_obligation_before_mvp.replaceAll("`process_isolation`", "the isolation");
  assert.match(viewValidator.processIsolationErrors(matrix(), noName).join("\n"), /process_isolation owner #18 does not name `process_isolation`/u);
  const noRecord = matrix();
  delete noRecord.install.model_account.process_isolation;
  assert.match(viewValidator.processIsolationErrors(noRecord, program()).join("\n"), /has no record/u);
  assertRejects(noRecord, /process_isolation/u);
});

test("§5b says the account isolates the models from the user and the Git directory and not from each other, measured, and #197's (R9-2)", () => {
  const fiveB = sectionOf(files[CONTRACT_PATH], "## 5b.", "## 6.");
  assert.doesNotMatch(fiveB, /That isolation, between the models, stays the daemon's — worktrees, sessions, custody/u);
  for (const phrase of [
    /The account isolates the models from the installing user and the project's Git directory, and from nothing else: not from each other/u,
    /a process of the account can read and rewrite another's worktree, its session directory and its Git view, and can signal, read the environment of and ptrace it/u,
    /`13c\/measure\/iso\.log`/u,
    /`PTRACE_ATTACH`/u,
    /against a process of the installing user the same signal, read and attach were refused/u,
    /worktrees, sessions and custody are placements and records, and against a process of the same uid a placement is a convention/u,
    /a separate worktree and a separate session directory for each, which a model that stays in its tools does not leave/u,
    /contamination that shows in content, refused \(`arena_candidate_contaminated`, `arena\.md` §4\), which catches what was copied and not what was only read/u,
    /OS isolation between model processes — between an Arena's candidates, between one Ticket's implementer and another's, between the models of different projects — is not provided and not claimed: it is #197's/u,
    /not taken without a successor matrix \(ADR-111\)/u,
  ]) {
    assert.match(fiveB, phrase);
  }
});

test("§5b says what closes when a step ends, that it helps a later process and not a concurrent one, and how a root is torn down (R9-2)", () => {
  const fiveB = sectionOf(files[CONTRACT_PATH], "## 5b.", "## 6.");
  for (const phrase of [
    /\*\*what closes when a step ends\*\* \(`process_isolation`, ADR-111\)/u,
    /closes it to `0700`, its own uid's, when the step ends/u,
    /could no longer list, read, write into or `chmod` the closed root, since it is not the root's owner/u,
    /a process whose working directory lay inside one was refused the same; a file descriptor it opened before the close still works/u,
    /A process that runs at the same time is not helped[^\n]*concurrent Arena candidates stay unisolated/u,
    /the name stays listed in the parent/u,
    /The session directory's root has to be the installing user's for this: one the account owns, the account can reopen/u,
    /The teardown reopens the root \(`chmod 2770`, autoskd\) and removes it under the model account/u,
  ]) {
    assert.match(fiveB, phrase);
  }
  // #13 proves it, #18 does it.
  const records = program().records;
  const obligation = (issue) => records.find((entry) => entry.issue_number === issue).implementation_obligation_before_mvp;
  assert.match(obligation(13), /is refused every traversal into the closed root of a finished step's worktree and session directory \(`process_isolation`\)/u);
  assert.match(obligation(18), /closes it to mode 0700 when the step ends[^.]*reopening it for the teardown under the account \(`process_isolation`: a process that runs at the same time is not helped, and OS isolation between model processes is #197's, ADR-111\)/u);
  assert.match(records.find((entry) => entry.issue_number === 13).verification_expectation, /a closed root of a finished step refusing the account/u);
  assert.match(sectionOf(files[CONTRACT_PATH], "## 5b.", "## 6."), /#13 and #18 — the owners of `install\.model_account\.process_isolation` — to be ones whose obligation names `process_isolation`/u);
  // §8 requires the test of it, and forbids the test of what does not hold.
  const eight = sectionOf(files[CONTRACT_PATH], "## 8.", "## 9.");
  assert.match(eight, /a finished step's closed root refusing the model account \(`process_isolation`\)/u);
  assert.match(eight, /no test that claims a concurrent model process is refused a running step's worktree — it is not \(§5b\), and OS isolation between model processes is #197's/u);
  assert.match(eight, /a process under the model account holding no `AUTOSK_SESSION_TOKEN` and writing no task metadata, the cap counters and baselines among it \(§5b\)/u);
});

test("Arena's contract, its matrix delivery, 01, 02 and README claim no isolation between model processes (R9-2)", () => {
  const arena = read("docs/contracts/arena.md");
  assert.doesNotMatch(arena, /## 4\. Isolation is a property, not an instruction/u);
  assert.doesNotMatch(arena, /see neither the judge's criteria nor each other's work/u);
  assert.doesNotMatch(arena, /work the same framing in isolation/u);
  assert.match(arena, /## 4\. Contamination is refused, not discouraged; separation is not an OS boundary/u);
  const four = sectionOf(arena, "## 4.", "## 5.");
  for (const phrase of [
    /separate worktrees with separate session directories/u,
    /The refusal is a check on content: it catches output that was copied or handed over, not a file that was only read/u,
    /What v1 does not provide is an OS boundary between candidates/u,
    /The account keeps the models from the installing user and the project's Git directory, and from nothing else/u,
    /OS isolation between candidates is #197's/u,
    /an Arena's candidates are separated, not isolated/u,
    /does not help a candidate that runs at the same time \(ADR-111\)/u,
  ]) {
    assert.match(four, phrase);
  }
  assert.match(arena, /Decided: the framing bound, contamination as a refusal rather than a rule, separation named as not an OS boundary/u);
  const point = program().enforcement_points.find((entry) => entry.point === "graph.arena-runtime");
  assert.doesNotMatch(point.delivery, /candidates isolated from each other/u);
  assert.match(point.delivery, /candidates in separate worktrees and session directories, contamination refused and no OS boundary between them \(#197's, docs\/contracts\/platform-support\.md §5b\)/u);
  assert.match(read("docs/program-capability-matrix.md"), /candidates in separate worktrees and session directories/u);
  assert.doesNotMatch(read("docs/program-capability-matrix.md"), /candidates isolated from each other/u);
  // 01 §1 and its Arena flow, 02 §5, README rule 19.
  const core = read("01-core-flows.md");
  assert.doesNotMatch(core, /candidate A: Grok, isolated worktree/u);
  assert.match(core, /candidate A: Grok, separate worktree/u);
  assert.match(core, /для процессов моделей она не ОС-граница[^\n]*одной учётной записью `autosk-model`[^\n]*вне v1 и принадлежит #197/u);
  const architecture = read("02-architecture.md");
  assert.match(architecture, /между процессами моделей они не граница[^\n]*которая отделяет их от пользователя и Git-каталога проекта, но не друг от друга[^\n]*#197/u);
  assert.match(architecture, /is denied accessibility\/ptrace\/keychain of the installing user; it does not isolate model processes from one another, which share its one uid/u);
  assert.match(read("03-technical-plan.md"), /sharing one uid with every other model process, does not isolate them from one another \(#197, ADR-111\)/u);
  const rule = read("README.md").split("\n").find((line) => line.startsWith("19. ")) ?? "";
  assert.match(rule, /а друг от друга процессы моделей она не отделяет: у них одна uid/u);
  assert.match(rule, /вне v1 и принадлежит #197/u);
});

test("02 §5 and §8, 03 and §5b mark the worktree cache and the provider sessions open, with their owners (R9-8)", () => {
  const architecture = read("02-architecture.md");
  const plan = read("03-technical-plan.md");
  assert.doesNotMatch(architecture, /с explicit owner binding и `AUTOSK_CWD` исходного проекта\.\n/u);
  for (const [text, phrase] of [
    [architecture, /`AUTOSK_CWD` исходного проекта — \*\*место открыто, а не правило\*\*[^\n]*#13 с #18 и #11[^\n]*ADR-111/u],
    [architecture, /provider-sessions\/ +# место открыто[^\n]*#13 с #18 и #11, ADR-111/u],
    [architecture, /review workspace лежит в `~\/\.autosk\/worktrees\/<project_root_sha256>\/\.\.\.` \(место открыто, §5: #13 с #18 и #11, ADR-111\)/u],
    [plan, /Это место открыто, а не правило[^\n]*#13 с #18 и #11[^\n]*ADR-111/u],
    [plan, /\(место открыто: модельная учётная запись этим домом пользоваться не может, решают #13 с #18 и #11/u],
    [plan, /provider_session_dir \(где этот каталог лежит и кому принадлежит — открыто за #13 с #18 и #11/u],
  ]) {
    assert.match(text, phrase);
  }
  const fiveB = sectionOf(files[CONTRACT_PATH], "## 5b.", "## 6.");
  assert.match(fiveB, /02 §5 and §8 and 03 put the external worktree cache and the review workspaces under the installing user's `~\/\.autosk\/worktrees\/<project_root_sha256>\/`[^\n]*neither is the rule until the placement is decided; 02, 03 and the package's not-claimed list say so \(ADR-111\)/u);
  assert.match(fiveB, /Where each model's worktree and session directory lie[^\n]*is open for #13 with #18 and #11/u);
  const own13 = program().records.find((entry) => entry.issue_number === 13).implementation_obligation_before_mvp;
  assert.match(own13, /Open with #18 and #11: where a model's worktree and session directory lie under the project root, and with them the placements 02 §5 and §8 and 03 still write as the rule/u);
});

test("the cap counters and baselines are model-forgeable today, and the account makes them not so (R9-6)", () => {
  const factory = read("docs/contracts/workflow-factory.md");
  assert.doesNotMatch(factory, /a model can write neither \(ADR-102\)/u);
  assert.doesNotMatch(factory, /while a model reaches no metadata write at all \(ADR-102\)/u);
  assert.match(factory, /under the model account of ADR-102 a model reaches no metadata write, so it could not open a cycle\. Today it can: every model process runs under autoskd's uid with `AUTOSK_SESSION_TOKEN` \(patch `0028`\)[^\n]*until #13's account, #11's environment and #18's metadata CAS exist \(ADR-111\)/u);
  assert.match(factory, /So is one a model rewrites, today: every model process runs under autoskd's uid with `AUTOSK_SESSION_TOKEN` \(patch `0028`\), the counter `transition_takings` is human-editable metadata \(patch `0034`\) and a baseline is a plain `autosk metadata set` leaf \(`src\/host\/workflow-factory\.mjs`\), so a model process can write either and reset a cap/u);
  assert.match(factory, /What ADR-102 makes true once #13's account exists is that a model holds no session token and no metadata write/u);
  assert.match(factory, /claims nothing against a model that writes metadata/u);
  const fiveB = sectionOf(files[CONTRACT_PATH], "## 5b.", "## 6.");
  assert.match(fiveB, /It writes no task metadata either, so the cap counters `step_visits` and `transition_takings` and the cap baselines `cap_baselines\.<cycle>\.<n>` \(`workflow-factory\.md` §11\) are leaves it cannot write\. That is what the account makes true, not what holds today/u);
  const records = program().records;
  const obligation = (issue) => records.find((entry) => entry.issue_number === issue).implementation_obligation_before_mvp;
  assert.match(obligation(11), /no `AUTOSK_SESSION_TOKEN` and no task-metadata write — the `transition_takings` and `step_visits` counters a cap reads and the `cap_baselines\.<cycle>\.<n>` leaves the factory writes are among the leaves it cannot write/u);
  assert.match(obligation(13), /holds no `AUTOSK_SESSION_TOKEN` and can write no task metadata — the cap counters and baselines among it —/u);
  assert.match(obligation(18), /and the cap baselines `cap_baselines\.<cycle>\.<n>`, which it reads to count a cap's cycle, are written only under the step-capability metadata CAS/u);
  assert.match(sectionOf(files[CONTRACT_PATH], "## 5b.", "## 6."), /#11 owns the model process environment — started under the account, with no daemon capability, no session token and no task-metadata write/u);
});

test("ADR-111 records the decision, and the ADRs whose text changed meaning say so (R9-2, R9-8, R9-6)", () => {
  const decisions = read("04-decisions.md");
  assert.ok(decisions.includes("## ADR-111:"), "ADR-111");
  const adr = decisions.slice(decisions.indexOf("## ADR-111:"));
  for (const phrase of [
    /R9-2/u, /R9-8/u, /R9-6/u, /#197/u, /Альтернатива/u, /`process_isolation`/u, /`arena_candidate_contaminated`/u, /PTRACE_ATTACH/u,
    /Одна uid не изолирует процессы моделей друг от друга: их не держит ни демон, ни worktree, ни сессия, ни custody/u,
    /Что не сделано и названо/u, /Ожидания, изменённые решением/u,
  ]) {
    assert.match(adr, phrase);
  }
  for (const [from, to] of [["## ADR-102:", "## ADR-103:"], ["## ADR-104:", "## ADR-105:"], ["## ADR-077:", "## ADR-078:"]]) {
    assert.match(sectionOf(decisions, from, to), /Изменено ADR-111/u, from);
  }
  // Alternative E's own text no longer says the daemon keeps the models apart.
  const adr102 = sectionOf(decisions, "## ADR-102:", "## ADR-103:");
  assert.match(adr102, /Альтернатива E: sandbox ОС на каждый процесс модели\. Отвергнута для v1[^\n]*\(Изменено ADR-111: [^\n]*друг от друга их не держит ни демон, ни worktree, ни сессия, ни custody/u);
  const adr104 = sectionOf(decisions, "## ADR-104:", "## ADR-105:");
  assert.doesNotMatch(adr104, /не подделает ни счётчик, ни baseline\./u);
  assert.doesNotMatch(adr104, /и модель не может ни того, ни другого \(ADR-102\);/u);
});
