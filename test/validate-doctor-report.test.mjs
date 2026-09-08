/**
 * Tests for the issue #34 doctor report.
 *
 * Three things must be impossible: a `warn` counted as ready, a `fail` with
 * nothing to do about it, and a check that could not run reported as one that
 * passed.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  CATEGORIES,
  CONTRACT_PATH,
  EXAMPLE_PATH,
  FAILING_EXAMPLE_PATH,
  REFUSALS,
  SCHEMA_PATH,
  doctorDesignDigest,
  loadFiles,
  readiness,
  reportStatus,
  unverifiableCount,
  validateDoctorReportDesign,
  validateReport,
} from "../scripts/validate-doctor-report.mjs";

const files = loadFiles();
const schema = JSON.parse(files[SCHEMA_PATH]);

const clean = () => JSON.parse(files[EXAMPLE_PATH]);
const broken = () => JSON.parse(files[FAILING_EXAMPLE_PATH]);

function mutated(mutate, base = clean) {
  const value = base();
  mutate(value);
  return value;
}

function assertRejects(value, pattern) {
  const errors = validateReport(value, schema);
  assert.ok(
    errors.some((message) => pattern.test(message)),
    `expected an error matching ${pattern}, got:\n${errors.join("\n") || "(none)"}`,
  );
}

test("the shipped design validates", () => {
  assert.deepEqual(validateDoctorReportDesign(files), []);
});

test("the status is computed from the checks that ran", () => {
  assert.equal(reportStatus(clean()), "pass");
  assert.equal(reportStatus(broken()), "fail");
  assertRejects(
    mutated((value) => {
      value.status = "fail";
    }),
    /status is fail, computed pass/u,
  );
});

test("a single warn warns, and a single fail fails", () => {
  assert.equal(
    reportStatus(
      mutated((value) => {
        value.checks[0].status = "warn";
        value.checks[0].remediation = "re-run it";
      }),
    ),
    "warn",
  );
  assert.equal(
    reportStatus(
      mutated((value) => {
        value.checks[0].status = "fail";
        value.checks[0].remediation = "fix it";
      }),
    ),
    "fail",
  );
});

test("unverifiable is reported beside the status, not folded into it", () => {
  // Those properties can never be established read-only, so degrading on them
  // would leave a healthy project permanently yellow — and a permanently yellow
  // status is one operators learn to ignore.
  const report = clean();
  assert.equal(unverifiableCount(report), 1);
  assert.equal(reportStatus(report), "pass");
});

test("but a workflow that requires an unverifiable check cannot start", () => {
  // The strictness lives where it bites. "We could not test it" never becomes
  // "it passed" for anyone who depends on it.
  const report = clean();
  assert.equal(readiness(report, ["daemon.helper_available"]), "ready");
  assert.match(readiness(report, ["providers.process_tree_kill"]), /doctor_required_set_unsatisfied/u);
});

test("warn is not readiness", () => {
  const warned = mutated((value) => {
    value.status = "warn";
    value.checks[0].status = "warn";
    value.checks[0].remediation = "re-run it";
  });
  assert.match(readiness(warned, [warned.checks[0].id]), /doctor_required_set_unsatisfied/u);
  assert.ok(files[CONTRACT_PATH].includes("`warn` never counts as ready"));
});

test("a required check that is absent is not satisfied by silence", () => {
  assert.match(readiness(clean(), ["governance.never_written"]), /doctor_required_set_unsatisfied/u);
});

test("the report does not decide who may proceed", () => {
  // Every workflow's required set differs, and a report that answered this would
  // be answering a question it was not asked.
  assert.ok(!("required_checks" in schema.properties));
  assert.ok(!("ready" in schema.properties));
});

test("a fail carries a remediation or a park reason", () => {
  const failing = broken().checks.find((check) => check.status === "fail");
  assert.ok(failing.remediation && failing.park_reason);
  assertRejects(
    mutated((value) => {
      const check = value.checks.find((entry) => entry.status === "fail");
      delete check.remediation;
      delete check.park_reason;
    }, broken),
    /doctor_remediation_missing/u,
  );
});

test("an unverifiable check says why, and nothing else does", () => {
  assertRejects(
    mutated((value) => {
      delete value.checks.find((check) => check.status === "unverifiable").unverifiable_reason;
    }),
    /doctor_check_unverifiable/u,
  );
  assertRejects(
    mutated((value) => {
      value.checks[0].unverifiable_reason = "not really";
    }),
    /only an unverifiable check explains/u,
  );
});

test("a result that expires before it was taken is not a result", () => {
  assertRejects(
    mutated((value) => {
      value.checks[0].provenance.expires_at = value.checks[0].provenance.checked_at;
    }),
    /expires before it was taken/u,
  );
});

test("evidence is redacted, and the report is exactly the file that gets pasted into an issue", () => {
  for (const planted of [
    "ghp_0123456789abcdefghijklmnopqrstuvwx",
    "AKIAIOSFODNN7EXAMPLE",
    "/Users/someone/project",
  ]) {
    assertRejects(
      mutated((value) => {
        value.checks[0].evidence = { detail: planted };
      }),
      /doctor_evidence_unredacted/u,
    );
  }
});

test("every category is exercised by the clean example", () => {
  const seen = new Set(clean().checks.map((check) => check.category));
  for (const category of CATEGORIES) assert.ok(seen.has(category), `${category} is not exercised`);
});

test("two checks with one id are refused, even when they disagree", () => {
  // An identical duplicate is caught by the schema. The case that matters is two
  // DIFFERENT results under one id: a reader asking for that check would get
  // whichever the code happened to find first.
  assertRejects(
    mutated((value) => {
      value.checks.push({ ...value.checks[0], status: "warn", remediation: "re-run it" });
    }),
    /appears twice/u,
  );
});

test("preflight and doctor share one implementation", () => {
  // Two implementations of one check agree until they do not, and that day a
  // workflow starts on a project doctor calls broken.
  assert.ok(files[CONTRACT_PATH].includes("run the **same** check implementations"));
});

test("every refusal is documented", () => {
  const contract = files[CONTRACT_PATH];
  for (const refusal of REFUSALS) assert.ok(contract.includes(refusal), `${refusal} is not documented`);
});

test("the design digest changes when any shipped file changes", () => {
  const before = doctorDesignDigest(files);
  const after = doctorDesignDigest({ ...files, [CONTRACT_PATH]: `${files[CONTRACT_PATH]}\n` });
  assert.notEqual(before, after);
});
