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

test("the ref-custody service runs in its own account and its privileged install is recorded", () => {
  // Round 7 of #39, R7-3: 02 §2 and 03 §9 rest on a separate-account helper
  // and a privileged install that no platform row or install record named, so
  // an implementer following this contract would run the helper as the user.
  const service = matrix().install.ref_custody_service;
  assert.equal(service.component, "autosk-flow-ref-custody");
  assert.equal(service.runs_as, "dedicated_service_account");
  assert.equal(service.runs_as_installing_user, false);
  assert.equal(service.protected_ref_writer, "autosk-flow-ref-custody");
  assert.equal(service.user_account_git_writes, false);
  assert.deepEqual(service.git_directory_writers, ["autosk-flow-ref-custody", "autoskd"]);
  assert.deepEqual(service.owner_issues, [5, 13]);
  assert.equal(service.privileged_install.requires_administrator, true);
  assert.ok(service.privileged_install.effects.length > 0);
  assertRejects(mutated((value) => { delete value.install.ref_custody_service; }), /ref_custody_service/u);
  for (const [field, wrong] of [
    ["runs_as_installing_user", true],
    ["user_account_git_writes", true],
    ["protected_ref_writer", "autoskd"],
    ["runs_as", "installing_user"],
  ]) {
    assertRejects(mutated((value) => { value.install.ref_custody_service[field] = wrong; }), /ref_custody_service/u);
  }
  assertRejects(mutated((value) => { value.install.ref_custody_service.git_directory_writers = ["autosk-flow-ref-custody", "autoskd", "installing_user"]; }), /ref_custody_service/u);
  assertRejects(mutated((value) => { value.install.ref_custody_service.owner_issues = [5]; }), /owner_issues/u);
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

test("the contract says who may write the project's .git once the custody install ran", () => {
  const contract = files[CONTRACT_PATH];
  assert.match(contract, /autosk-flow-ref-custody/u);
  assert.match(contract, /dedicated service account/u);
  assert.match(contract, /privileged install/u);
  assert.match(contract, /installing user's own account no longer writes the project's `\.git`/u);
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
