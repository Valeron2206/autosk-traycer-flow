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
  MAX_EVIDENCE_KEYS,
  MAX_EVIDENCE_VALUE,
  buildReport,
  checkResult,
  isExpired,
  overallStatus,
  readiness,
  redactEvidence,
  redactValue,
  reportDigest,
  unverifiableCount,
} from "../src/host/doctor.mjs";
import { TTL_MS, checkRegistry, runChecks } from "../src/host/doctor-checks.mjs";
import { ROOT, generateReport, hostEnv } from "../scripts/autosk-flow-doctor.mjs";
import { validateJsonSchema } from "../scripts/validate-planning-ref-design.mjs";
import { UNPINNED_DAEMON_PRIMITIVES } from "../src/host/daemon-preflight.mjs";
import { capabilityRemediation } from "../src/host/doctor-checks.mjs";
import { filesUsing } from "../scripts/lib/code-references.mjs";

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
      // The signer endpoint is refused to this process, which is the one thing
      // a probe from here can positively observe about a boundary. A path that
      // simply does not exist is not that (debt 10d, R6-12).
      if (target === "/run/autosk/signer.sock") throw Object.assign(new Error("EACCES"), { code: "EACCES" });
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

test("the signer boundary check is conditioned on both halves, not on either", async () => {
  // Three panel seats named this boundary across two rounds, and predicate
  // mutation confirmed mechanically what they suspected: only the healthy path
  // was tested, so `reachable && distinct` could have been `reachable ||
  // distinct` and every test still passed. It decides whether a model workflow
  // may start at all.
  const signer = async (overrides) => {
    const results = await runChecks(fakeEnv(overrides));
    return results.find((result) => result.id === "security.signer_boundary");
  };

  // Unreachable from here and a distinct signer identity: the only pass.
  const healthy = await signer({});
  assert.equal(healthy.status, "pass");
  assert.equal(healthy.evidence.reachable_from_here, false);
  assert.equal(healthy.evidence.signer_identity_distinct, true);

  // Reachable from the process a model runs in is a fail, whatever the daemon
  // reports about itself — a boundary you can reach is not a boundary.
  const reachable = await signer({ stat: async () => ({ size: 1 }) });
  assert.equal(reachable.status, "fail");
  assert.match(reachable.remediation, /reachable from the process/u);

  // Unreachable but the daemon says the signer shares this process: neither a
  // pass nor a fail, because nothing was established.
  const sameProcess = await signer({ signerIdentity: async () => ({ same_process: true }) });
  assert.equal(sameProcess.status, "unverifiable");
  assert.equal(sameProcess.evidence.signer_identity_distinct, false);
  assert.match(sameProcess.unverifiable_reason, /no signer identity/u);

  // A probe that throws is the same answer: unverifiable, not pass.
  const noIdentity = await signer({ signerIdentity: async () => { throw new Error("no daemon"); } });
  assert.equal(noIdentity.status, "unverifiable");

  // And an undeclared boundary is refused before any probe runs.
  const undeclared = await signer({ signerEndpoint: undefined });
  assert.equal(undeclared.status, "unverifiable");
  assert.equal(undeclared.evidence.declared, false);
});

test("a declared signer endpoint that does not exist is a failure, not a boundary", async () => {
  // Round 6 (R6-12): the probe read any error from `stat` as "unreachable from
  // here", so a mistyped endpoint passed as a boundary. A path that is not there
  // separates nothing; only a refusal to this process is observed separation.
  const signer = async (overrides) =>
    (await runChecks(fakeEnv(overrides))).find((result) => result.id === "security.signer_boundary");
  for (const code of ["ENOENT", "ENOTDIR"]) {
    const missing = await signer({
      signerEndpoint: "/run/autosk/signer.sokc",
      stat: async () => { throw Object.assign(new Error(code), { code }); },
    });
    assert.equal(missing.status, "fail", code);
    assert.equal(missing.evidence.reachable_from_here, false);
    assert.equal(missing.evidence.probe_error, code);
    assert.match(missing.remediation, /does not exist/u);
  }
  // The daemon's report cannot rescue a missing endpoint.
  const missingButDistinct = await signer({
    stat: async () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); },
  });
  assert.equal(missingButDistinct.status, "fail");

  // A denial is the observation a pass needs, EPERM as much as EACCES.
  const denied = await signer({ stat: async () => { throw Object.assign(new Error("EPERM"), { code: "EPERM" }); } });
  assert.equal(denied.status, "pass");
  assert.equal(denied.evidence.probe_error, "EPERM");

  // Any other error says nothing either way: not a pass, not a verdict.
  const unexplained = await signer({ stat: async () => { throw Object.assign(new Error("EIO"), { code: "EIO" }); } });
  assert.equal(unexplained.status, "unverifiable");
  assert.equal(unexplained.evidence.probe_error, "EIO");
  assert.match(unexplained.unverifiable_reason, /EIO/u);
  assert.equal(unexplained.remediation, undefined);
});

test("no operator variable stands in for the daemon's report of the signer identity", async () => {
  // Round 6 (R6-10): the "daemon report" was `AUTOSK_SIGNER_SAME_PROCESS`, an
  // environment variable, so `=0` and a denied path passed the check with no
  // signer anywhere. The pinned daemon reports no signer identity — its
  // `meta.capabilities` names only `task.creation-binding` — so the host has no
  // source for that half, and the check cannot pass on this host.
  const saved = process.env.AUTOSK_SIGNER_SAME_PROCESS;
  process.env.AUTOSK_SIGNER_SAME_PROCESS = "0";
  try {
    const env = hostEnv();
    await assert.rejects(() => env.signerIdentity(), /reports no signer identity/u);
    const results = await runChecks({
      ...env,
      signerEndpoint: "/run/autosk/signer.sock",
      stat: async () => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); },
    });
    const signer = results.find((result) => result.id === "security.signer_boundary");
    assert.equal(signer.status, "unverifiable");
    assert.equal(signer.evidence.signer_identity_distinct, false);
    assert.match(signer.unverifiable_reason, /no signer identity/u);
  } finally {
    if (saved === undefined) delete process.env.AUTOSK_SIGNER_SAME_PROCESS;
    else process.env.AUTOSK_SIGNER_SAME_PROCESS = saved;
  }
});

test("a check that passed says nothing about why it could not be checked", async () => {
  // A `pass` carrying a remediation, or a reason it was unverifiable, is a
  // contradiction the report would print with a straight face. Predicate
  // mutation found several conditions that decide those fields and no test that
  // reads them on the passing side.
  const results = await runChecks(fakeEnv());
  const passed = results.filter((result) => result.status === "pass");
  assert.ok(passed.length > 3, "the healthy fixture should pass several checks");
  for (const result of passed) {
    assert.equal(result.remediation, undefined, `${result.id} passed and still advises a fix`);
    assert.equal(result.unverifiable_reason, undefined, `${result.id} passed and still says it could not be checked`);
  }
  // And the converse: a failing check does advise something.
  const failing = (await runChecks(fakeEnv({ stat: async () => ({ size: 1 }) })))
    .filter((result) => result.status === "fail");
  for (const result of failing) assert.ok(result.remediation, `${result.id} failed and advises nothing`);
});

test("a command that ran and refused is as much a failure as one that could not run", async () => {
  // `!ok || code !== 0` is two different worlds — the binary is missing, or it
  // answered no. Only the first was ever exercised, so the `||` could have been
  // an `&&` and a refusing git would have read as a healthy one.
  const refusing = fakeEnv({
    async run(command, args) {
      if (command === "git" && args[0] === "--version") return { code: 1, stdout: "" };
      if (command === "git" && args[0] === "rev-parse") return { code: 128, stdout: "" };
      if (command === "git" && args[0] === "status") return { code: 0, stdout: "" };
      if (command === "git" && args[0] === "remote") return { code: 0, stdout: "origin\n" };
      throw new Error(`unexpected command ${command}`);
    },
  });
  const results = await runChecks(refusing);
  const byId = new Map(results.map((result) => [result.id, result]));
  assert.equal(byId.get("git_delivery.git_available").status, "fail");
  assert.equal(byId.get("git_delivery.git_available").evidence.error, "1");
  assert.equal(byId.get("project_identity.git_worktree").status, "fail");
  assert.equal(byId.get("project_identity.git_worktree").evidence.error, "128");
});

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
  // Three since debt 11c: the daemon's reachability, live routes, and the
  // daemon capability check, which this host hands no report. Five since debt
  // 12a: the model account and the ref-custody install, which no probe
  // establishes yet (#13).
  assert.equal(unverifiableCount(report), 5);
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
  // The instant itself: a result whose shelf life ends exactly now has ended.
  // `<=` and `<` differ by that one moment, and nothing asked about it.
  assert.equal(isExpired(stale, NOW + 1000), true);
  assert.equal(isExpired(stale, NOW + 999), false);
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
  // At the bound and one below it: a value of exactly the maximum is kept
  // whole, and the ellipsis appears only when something was actually cut.
  assert.equal(redactValue("x".repeat(MAX_EVIDENCE_VALUE)), "x".repeat(MAX_EVIDENCE_VALUE));
  assert.ok(!redactValue("x".repeat(MAX_EVIDENCE_VALUE)).endsWith("…"));
  assert.ok(redactValue("x".repeat(MAX_EVIDENCE_VALUE + 1)).endsWith("…"));
  // A one-character home is not a home: replacing "/" everywhere would rewrite
  // every path in the report.
  assert.equal(redactValue("/home/operator/x", { home: "/" }), "/home/operator/x");

  // Exactly as many keys as a report may hold is admitted; one more is not.
  const keys = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, "v"]));
  assert.doesNotThrow(() => redactEvidence(keys(MAX_EVIDENCE_KEYS)));
  assert.throws(() => redactEvidence(keys(MAX_EVIDENCE_KEYS + 1)), (error) => error.code === "doctor_evidence_unredacted");
  // And a key of exactly sixty-four characters is a key; sixty-five is not.
  assert.doesNotThrow(() => redactEvidence({ ["k".repeat(64)]: "v" }));
  assert.throws(() => redactEvidence({ ["k".repeat(65)]: "v" }), (error) => error.code === "doctor_evidence_unredacted");
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

// Debt 11c (R7-11): `requireDaemonCapabilities` had no caller, and no check
// compared the daemon's `meta.capabilities` with what the flow pins. The
// doctor now hands the report it is given to that function and nothing else
// decides; without a report the check is `unverifiable`, as the signer check
// is without the daemon's signer identity (debt 10d).
const SERIES_REPORT = Object.freeze({
  capabilities: [{ name: "task.creation-binding", version: 2, methods: ["task.create_bound"] }],
});

async function capabilitiesCheck(overrides) {
  return (await runChecks(fakeEnv(overrides))).find((result) => result.id === "daemon.capabilities_pinned");
}

test("the daemon capability check is registered in the daemon category", () => {
  const entry = checkRegistry(fakeEnv()).find((item) => item.id === "daemon.capabilities_pinned");
  assert.ok(entry, "doctor has a daemon capability check");
  assert.equal(entry.category, "daemon");
});

test("with no report of the daemon's capabilities the check is unverifiable, never a pass", async () => {
  const none = await capabilitiesCheck({});
  assert.equal(none.status, "unverifiable");
  assert.match(none.unverifiable_reason, /no report of the daemon's capabilities/u);
  assert.equal(none.evidence.reported, false);
  const thrown = await capabilitiesCheck({ daemonCapabilities: async () => { throw Object.assign(new Error("x"), { code: "ECONNREFUSED" }); } });
  assert.equal(thrown.status, "unverifiable");
  assert.match(thrown.unverifiable_reason, /ECONNREFUSED/u);
  assert.equal(thrown.evidence.reported, false);
});

test("the series' own report fails the check with the preflight's refusal", async () => {
  const result = await capabilitiesCheck({ daemonCapabilities: async () => structuredClone(SERIES_REPORT) });
  assert.equal(result.status, "fail");
  assert.equal(result.evidence.reported, true);
  assert.equal(result.evidence.refusal, "daemon_capability_missing");
  assert.equal(result.evidence.missing, "authority.user-decision, workflow.custody");
  assert.match(result.remediation, /ADR-023|ADR-025/u);
});

test("a report naming every primitive still fails: an unpinned primitive has nothing to compare against", async () => {
  const claiming = {
    capabilities: [
      ...structuredClone(SERIES_REPORT.capabilities),
      { name: "authority.user-decision", version: 1, methods: ["authority.record"] },
      { name: "workflow.custody", version: 1, methods: ["workflow.cas"] },
    ],
  };
  const result = await capabilitiesCheck({ daemonCapabilities: async () => claiming });
  assert.equal(result.status, "fail");
  assert.equal(result.evidence.refusal, "daemon_capability_missing");
});

test("a pinned capability at another revision, other methods or an unreadable report fails with its own refusal", async () => {
  const older = await capabilitiesCheck({ daemonCapabilities: async () => ({ capabilities: [{ name: "task.creation-binding", version: 1, methods: ["task.create_bound"] }] }) });
  assert.equal(older.status, "fail");
  assert.equal(older.evidence.refusal, "daemon_capability_version_mismatch");
  assert.match(older.evidence.mismatched, /task\.creation-binding is v1, this flow is written for v2/u);
  assert.equal(older.evidence.missing, undefined);
  const renamed = await capabilitiesCheck({ daemonCapabilities: async () => ({ capabilities: [{ name: "task.creation-binding", version: 2, methods: ["task.createBound"] }] }) });
  assert.equal(renamed.evidence.refusal, "daemon_capability_method_mismatch");
  assert.match(renamed.evidence.mismatched, /implemented by \[task\.createBound\]/u);
  const unreadable = await capabilitiesCheck({ daemonCapabilities: async () => ({ capabilities: "all of them" }) });
  assert.equal(unreadable.status, "fail");
  assert.equal(unreadable.evidence.refusal, "daemon_capability_invalid");
  const shape = await capabilitiesCheck({ daemonCapabilities: async () => ({ capabilities: [], extra: true }) });
  assert.equal(shape.status, "fail");
  assert.equal(shape.evidence.refusal, "invalid_record");
});

test("the real host hands the check no report: doctor does not contact the daemon", async () => {
  // Review of 11c (L6): the host supplies no report at all, rather than a
  // reader that fails, so the check says that no report was supplied — not
  // that reading one failed.
  const env = hostEnv();
  assert.equal(Object.hasOwn(env, "daemonCapabilities"), false);
  const results = await runChecks(env);
  const found = results.find((result) => result.id === "daemon.capabilities_pinned");
  assert.equal(found.status, "unverifiable");
  assert.match(found.unverifiable_reason, /no report of the daemon's capabilities was supplied/u);
  assert.equal(found.evidence.reported, false);
  assert.equal(found.evidence.probe_error, undefined);
});

test("the remediation names the primitives no daemon can satisfy yet, as the preflight declares them", async () => {
  // Read from the preflight rather than typed in, so the advice cannot name a
  // primitive that has since been pinned, or miss one added later.
  const result = await capabilitiesCheck({ daemonCapabilities: async () => structuredClone(SERIES_REPORT) });
  for (const { name, adr } of UNPINNED_DAEMON_PRIMITIVES) assert.ok(result.remediation.includes(`${name} (${adr})`), name);
  assert.equal(result.remediation, capabilityRemediation(UNPINNED_DAEMON_PRIMITIVES));
  // Review of 11c (L3): once every primitive is pinned, the advice claims none
  // is unpinned rather than printing an empty list.
  const pinned = capabilityRemediation([]);
  assert.doesNotMatch(pinned, /no pinned revision/u);
  assert.doesNotMatch(pinned, / {2}| \(|\( /u);
  assert.match(pinned, /^Run a daemon whose meta\.capabilities carries every capability this flow requires, at the pinned revision and methods\.$/u);
  const one = capabilityRemediation([{ name: "workflow.custody", adr: "ADR-025" }]);
  assert.match(one, /workflow\.custody \(ADR-025\) has no pinned revision yet, so no daemon report satisfies this check until it is specified\.$/u);
  assert.match(result.remediation, / and workflow\.custody \(ADR-025\) have no pinned revision yet, so no daemon report satisfies this check until they are specified\.$/u);
});

test("outside tests, the doctor check is the one caller of requireDaemonCapabilities", async () => {
  // R7-11: the function had no caller in src/ or scripts/. Measured over the
  // code, the definition apart, so a second caller — the extension entry
  // point's call at load, once it exists — is one this test names. Review of
  // 11c (L1): TypeScript sources count, and so does a use that is not a
  // literal call (an alias, a callback, an import).
  const users = await filesUsing({ root: ROOT, dirs: ["src", "scripts"], identifier: "requireDaemonCapabilities", exclude: ["src/host/daemon-preflight.mjs"] });
  assert.deepEqual(users, ["src/host/doctor-checks.mjs"]);
});

// Debt 12a (round 8 of #39, R8-1 and R8-13): the model account the privileged
// install creates and the ref-custody install are preconditions no check
// probed. Each is a named check now; no probe of either exists in this
// repository, so each says it could not be established and names who owns the
// probe (#13) — which blocks every workflow that requires it — rather than
// passing or being absent.
import { MODEL_ACCOUNT } from "../src/host/doctor-checks.mjs";

test("the model account and the ref-custody install are named checks no probe establishes yet (R8-1, R8-13)", async () => {
  const registry = checkRegistry(fakeEnv());
  for (const id of ["security.model_account", "security.ref_custody"]) {
    const entry = registry.find((item) => item.id === id);
    assert.ok(entry, `${id} is registered`);
    assert.equal(entry.category, "security", id);
  }
  // On the healthy fixture and on the real host alike: no probe, so never a
  // pass and never a silent absence.
  for (const env of [fakeEnv(), hostEnv()]) {
    const found = await statuses(env);
    const model = found.get("security.model_account");
    assert.equal(model.status, "unverifiable");
    assert.equal(model.evidence.probe, "none");
    assert.equal(model.evidence.account, "autosk-model");
    assert.match(model.unverifiable_reason, /no probe of the model account autosk-model exists yet/u);
    assert.match(model.unverifiable_reason, /#13/u);
    const custody = found.get("security.ref_custody");
    assert.equal(custody.status, "unverifiable");
    assert.equal(custody.evidence.probe, "none");
    // Fix round 2 (ADR-102): what the check proves is the helper — a process
    // of the installing user with its socket and journal — and the
    // repository's pins, no longer a service account's install (was: "no
    // probe of the ref-custody install exists yet").
    assert.match(custody.unverifiable_reason, /no probe of the ref-custody helper exists yet/u);
    assert.match(custody.unverifiable_reason, /its process, its socket and journal and the repository's pins/u);
    assert.match(custody.unverifiable_reason, /ref_custody_unavailable/u);
    assert.match(custody.unverifiable_reason, /#13's with #5/u);
  }
  // The account the check names is the one the platform install record names.
  const platform = JSON.parse(await readFile(path.join(ROOT, "resources/platform-support/platform-support.v1.json"), "utf8"));
  assert.equal(MODEL_ACCOUNT, platform.install.model_account.account);
});
