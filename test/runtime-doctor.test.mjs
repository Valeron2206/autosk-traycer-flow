/**
 * Tests for the `autosk-flow doctor` runtime (issue #34).
 *
 * The contract's two load-bearing rules are the ones most of these check:
 * `warn` is never readiness, and `unverifiable` does not degrade the status but
 * does block a workflow that requires that check. Both are easy to state and
 * easy to implement backwards.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  CATEGORIES,
  MAX_EVIDENCE_VALUE,
  buildReport,
  checkResult,
  isExpired,
  overallStatus,
  readiness,
  redactValue,
  reportDigest,
  unverifiableCount,
} from "../src/host/doctor.mjs";
import { TTL_MS, checkRegistry, runChecks } from "../src/host/doctor-checks.mjs";
import { ROOT, generateReport, hostEnv } from "../scripts/autosk-flow-doctor.mjs";
import { validateJsonSchema } from "../scripts/validate-planning-ref-design.mjs";

const NOW = Date.parse("2026-09-08T12:00:00.000Z");

function provenance(offsetMs = TTL_MS.fast) {
  return {
    tool: "autosk-flow-doctor",
    version: "0.0.0",
    checked_at: new Date(NOW).toISOString(),
    expires_at: new Date(NOW + offsetMs).toISOString(),
  };
}

function check(id, category, status, extra = {}) {
  return { id, category, status, evidence: {}, provenance: provenance(), ...extra };
}

/** A host where everything is present and nothing is Traycer. */
function fakeEnv(overrides = {}) {
  const files = new Map([
    [
      "compat/autosk/manifest.v1.json",
      JSON.stringify({ upstream: { commit: "5163f00d" }, patches: [1, 2, 3], result_tree: "9f52d343" }),
    ],
    [
      "resources/artifact-registry/artifact-registry.v1.json",
      JSON.stringify({ classes: [{ class: "contract_document", paths: ["docs/contracts/one.md"] }] }),
    ],
    [
      "resources/design-candidate/design-candidate.v1.json",
      JSON.stringify({ required_panel: [1, 2, 3, 4].map((n) => ({ seat: `s${n}`, route: `r${n}` })) }),
    ],
  ]);
  const present = new Set(["docs/contracts/one.md", "/bin/autoskd", "/bin/autosk-store-lock"]);
  return {
    // A healthy host declares where its signer is and the daemon says it runs
    // outside this process: that is what "the boundary was checked" means.
    signerEndpoint: "/run/autosk/signer.sock",
    signerIdentity: async () => ({ same_process: false }),
    root: "/project",
    home: "/home/operator",
    processEnv: { PATH: "/usr/bin" },
    nowMs: () => NOW,
    toolVersion: "0.0.0",
    nodeVersion: "v24.4.0",
    requiredNodeMajor: 24,
    daemonBinary: "/bin/autoskd",
    helperBinary: "/bin/autosk-store-lock",
    join: (...parts) => parts.join("/"),
    async readFile(relative) {
      if (!files.has(relative)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return files.get(relative);
    },
    async readFileBytes() {
      return Buffer.from("helper bytes");
    },
    async stat(target) {
      if (!present.has(target)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return { size: 1 };
    },
    async run(command, args) {
      if (command === "git" && args[0] === "rev-parse") return { code: 0, stdout: "abc123\n" };
      if (command === "git" && args[0] === "status") return { code: 0, stdout: "" };
      if (command === "git" && args[0] === "--version") return { code: 0, stdout: "git version 2.55.0\n" };
      if (command === "git" && args[0] === "remote") return { code: 0, stdout: "origin\n" };
      throw new Error(`unexpected command ${command}`);
    },
    async which() {
      return "";
    },
    ...overrides,
  };
}

async function statuses(env) {
  const results = await runChecks(env);
  return new Map(results.map((result) => [result.id, result]));
}

test("every registered check produces a result, including one whose probe throws", async () => {
  // A check that disappears from the report is worse than a failing one: the
  // report would be shorter and still say pass.
  const env = fakeEnv();
  const registry = checkRegistry(env);
  const results = await runChecks(env, registry);
  assert.equal(results.length, registry.length);
  assert.deepEqual(results.map((result) => result.id), registry.map((check) => check.id));

  const throwing = [...registry.slice(0, 2), {
    id: "probe.explodes",
    category: registry[0].category,
    run: () => { throw new Error("probe blew up"); },
  }];
  const withFailure = await runChecks(env, throwing);
  assert.equal(withFailure.length, throwing.length);
  const failed = withFailure.at(-1);
  assert.equal(failed.id, "probe.explodes");
  assert.equal(failed.status, "fail");
  assert.match(failed.evidence.error, /probe blew up/u);
});

test("a healthy host passes, and says how much it could not establish", async () => {
  const results = await runChecks(fakeEnv());
  const report = buildReport({
    checks: results,
    projectIdentity: "autosk-flow:9f52d343",
    runtimeIdentity: "r".repeat(64),
    tool: { name: "autosk-flow-doctor", version: "0.0.0" },
    generatedAt: new Date(NOW).toISOString(),
    home: "/home/operator",
  });
  assert.equal(report.status, "pass");
  // The count is reported beside the status rather than folded into it.
  assert.equal(unverifiableCount(report), 2);
});

test("every category has a check, so requiring one cannot be empty", () => {
  const covered = new Set(checkRegistry(fakeEnv()).map((entry) => entry.category));
  for (const category of CATEGORIES) assert.ok(covered.has(category), `${category} has no check`);
});

test("unverifiable does not degrade the status", () => {
  const checks = [check("a.b", "daemon", "pass"), check("c.d", "providers", "unverifiable", {
    unverifiable_reason: "requires a real dispatch",
  })];
  assert.equal(overallStatus(checks), "pass");
});

test("warn is never readiness, and neither is unverifiable", () => {
  const report = {
    checks: [
      check("a.b", "daemon", "pass"),
      check("c.d", "providers", "warn"),
      check("e.f", "security", "unverifiable", { unverifiable_reason: "not read-only" }),
    ],
  };
  assert.equal(readiness(report, ["a.b"], NOW).ready, true);
  // A required check that warns blocks that workflow; a non-required one does not.
  assert.equal(overallStatus(report.checks), "warn");
  assert.deepEqual(readiness(report, ["a.b", "c.d"], NOW).blocking, [
    { id: "c.d", reason: "doctor_required_set_unsatisfied" },
  ]);
  // "We could not test it" never becomes "it passed" for anyone who depends on it.
  assert.deepEqual(readiness(report, ["e.f"], NOW).blocking, [
    { id: "e.f", reason: "doctor_check_unverifiable" },
  ]);
  assert.deepEqual(readiness(report, ["nothing.here"], NOW).blocking, [
    { id: "nothing.here", reason: "doctor_required_set_unsatisfied" },
  ]);
});

test("an expired result is not a result", () => {
  const stale = check("a.b", "daemon", "pass", { provenance: provenance(1000) });
  assert.equal(isExpired(stale, NOW + 2000), true);
  assert.equal(isExpired(stale, NOW), false);
  assert.deepEqual(readiness({ checks: [stale] }, ["a.b"], NOW + 2000).blocking, [
    { id: "a.b", reason: "doctor_check_expired" },
  ]);
});

test("a failing check carries a remediation, and an unverifiable one a reason", () => {
  // A failure with neither tells the operator something is wrong and leaves
  // them exactly where they were.
  const code = (name) => (error) => error.code === name;
  assert.throws(() => checkResult(check("a.b", "daemon", "fail")), code("doctor_remediation_missing"));
  assert.doesNotThrow(() => checkResult(check("a.b", "daemon", "fail", { park_reason: "provider_unavailable" })));
  assert.throws(() => checkResult(check("a.b", "daemon", "unverifiable")), code("doctor_check_unverifiable"));
});

test("an unknown category or a malformed id is refused", () => {
  const unknown = (error) => error.code === "doctor_category_unknown";
  assert.throws(() => checkResult(check("a.b", "made_up", "pass")), unknown);
  assert.throws(() => checkResult(check("nodot", "daemon", "pass")), unknown);
  assert.throws(() => checkResult(check("a.b", "daemon", "excellent")), unknown);
});

test("evidence is redacted on the way in", () => {
  // A token in the evidence of the check that found a token is the same leak
  // the check exists to prevent.
  // Asserted as a property — the credential does not survive — rather than as
  // an exact rendering, so tightening a pattern later is not a test failure.
  const ghToken = `ghp_${"a".repeat(36)}`;
  assert.ok(!redactValue(`token ${ghToken}`).includes(ghToken));
  assert.ok(!redactValue("Authorization: Bearer abcdefgh12345678").includes("abcdefgh12345678"));
  assert.equal(redactValue("/home/operator/project", { home: "/home/operator" }), "~/project");
  assert.equal(redactValue("x".repeat(400)).length, MAX_EVIDENCE_VALUE);
  // A digest is not a secret, and redacting it would empty the identity checks
  // while looking careful.
  const digest = "a".repeat(64);
  assert.equal(redactValue(digest), digest);
  assert.equal(redactValue("api_key=abcdef123456"), "[redacted]");
  const redacted = checkResult(
    check("a.b", "daemon", "pass", { evidence: { path: "/home/operator/x", n: 3, ok: true } }),
    { home: "/home/operator" },
  );
  assert.deepEqual(redacted.evidence, { path: "~/x", n: 3, ok: true });
});

test("evidence is bounded in shape as well as in length", () => {
  const unredacted = (error) => error.code === "doctor_evidence_unredacted";
  const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, "v"]));
  assert.throws(() => checkResult(check("a.b", "daemon", "pass", { evidence: many })), unredacted);
  assert.throws(
    () => checkResult(check("a.b", "daemon", "pass", { evidence: { nested: { no: true } } })),
    unredacted,
  );
});

test("an over-long evidence key is refused, and an empty report is not a report", () => {
  // The key bound matters for the same reason the value bound does: the schema
  // caps key length, so a report that got past this would fail validation
  // somewhere less obvious.
  const longKey = { [`k${"e".repeat(70)}`]: "v" };
  assert.throws(
    () => checkResult(check("a.b", "daemon", "pass", { evidence: longKey })),
    (error) => error.code === "doctor_evidence_unredacted",
  );
  assert.throws(
    () =>
      buildReport({
        checks: [],
        projectIdentity: "p",
        runtimeIdentity: "r",
        tool: { name: "t", version: "1" },
        generatedAt: new Date(NOW).toISOString(),
      }),
    (error) => error.code === "doctor_required_set_unsatisfied",
  );
});

test("a duplicate check id is refused rather than silently deduplicated", () => {
  assert.throws(
    () =>
      buildReport({
        checks: [check("a.b", "daemon", "pass"), check("a.b", "daemon", "pass")],
        projectIdentity: "p",
        runtimeIdentity: "r",
        tool: { name: "t", version: "1" },
        generatedAt: new Date(NOW).toISOString(),
      }),
    (error) => /A check id appears twice/u.test(error.message),
  );
});

test("a probe that throws becomes a failing check, never a gap", async () => {
  const results = await runChecks(fakeEnv(), [
    { id: "a.b", category: "daemon", run() { throw new Error("probe exploded"); } },
  ]);
  assert.equal(results.length, 1);
  assert.equal(results[0].status, "fail");
  assert.ok(results[0].remediation);
});

test("a missing daemon binary fails with something to do about it", async () => {
  const found = await statuses(fakeEnv({ daemonBinary: "" }));
  assert.equal(found.get("daemon.binary_present").status, "fail");
  assert.match(found.get("daemon.binary_present").remediation, /prepare-autosk/u);
});

test("the helper check states the digest, not that the file exists", async () => {
  const found = await statuses(fakeEnv());
  assert.match(found.get("daemon.store_lock_helper").evidence.sha256, /^[0-9a-f]{64}$/u);
});

test("a dirty worktree warns and does not fail", async () => {
  const found = await statuses(
    fakeEnv({
      async run(command, args) {
        if (command === "git" && args[0] === "status") return { code: 0, stdout: " M file\n" };
        return fakeEnv().run(command, args);
      },
    }),
  );
  assert.equal(found.get("project_identity.git_worktree").status, "warn");
  assert.equal(found.get("project_identity.git_worktree").evidence.dirty, true);
});

test("a contract listed in the registry but absent is a failure", async () => {
  const found = await statuses(
    fakeEnv({
      async stat(target) {
        if (target === "docs/contracts/one.md") throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return { size: 1 };
      },
    }),
  );
  assert.equal(found.get("governance.contracts_present").status, "fail");
  assert.equal(found.get("governance.contracts_present").evidence.missing, 1);
});

test("a missing origin warns, because a local run is not broken by it", async () => {
  const found = await statuses(
    fakeEnv({
      async run(command, args) {
        if (command === "git" && args[0] === "remote") return { code: 0, stdout: "upstream\n" };
        return fakeEnv().run(command, args);
      },
    }),
  );
  assert.equal(found.get("git_delivery.origin_configured").status, "warn");
});

test("Traycer is a dependency question, not an installation question", async () => {
  // An installation in the operator's home says nothing about this flow, and
  // failing on it would block a healthy project.
  const installed = await statuses(
    fakeEnv({
      async stat(target) {
        if (target === "/home/operator/.traycer") return { size: 1 };
        return fakeEnv().stat(target);
      },
    }),
  );
  assert.equal(installed.get("security.no_traycer").status, "pass");
  assert.equal(installed.get("security.no_traycer").evidence.installed_in_home, true);

  const depends = await statuses(fakeEnv({ processEnv: { TRAYCER_HOME: "/opt/traycer" } }));
  assert.equal(depends.get("security.no_traycer").status, "fail");
  assert.equal(depends.get("security.no_traycer").evidence.env_keys, "TRAYCER_HOME");

  const configured = await statuses(fakeEnv({ daemonBinary: "/opt/traycer/bin/autoskd" }));
  assert.equal(configured.get("security.no_traycer").status, "fail");
});

test("an old Node fails with the version it needs", async () => {
  const found = await statuses(fakeEnv({ nodeVersion: "v20.11.0" }));
  assert.equal(found.get("scheduler.node_version").status, "fail");
  assert.match(found.get("scheduler.node_version").remediation, /Node 24/u);
});

test("a panel that is not four seats fails", async () => {
  const found = await statuses(
    fakeEnv({
      async readFile(relative) {
        if (relative === "resources/design-candidate/design-candidate.v1.json") {
          return JSON.stringify({ required_panel: [{ seat: "opus", route: "r1" }] });
        }
        return fakeEnv().readFile(relative);
      },
    }),
  );
  assert.equal(found.get("providers.panel_routes_declared").status, "fail");
});

test("the real report validates against the shipped schema", async () => {
  // The report is the artifact other things read, so the runtime and the design
  // contract are checked against each other rather than side by side.
  const schema = JSON.parse(
    await readFile(path.join(ROOT, "resources/doctor-report/doctor-report.schema.json"), "utf8"),
  );
  const report = await generateReport(hostEnv());
  assert.deepEqual(validateJsonSchema(report, schema), []);
  assert.match(reportDigest(report), /^[0-9a-f]{64}$/u);
  // Whatever this machine looks like, the report says something about every
  // check the registry declares.
  assert.equal(report.checks.length, checkRegistry(hostEnv()).length);
});
