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
