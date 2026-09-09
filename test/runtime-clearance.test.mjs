/**
 * Tests for the clearance path (issue #20 runtime).
 *
 * The issue's shape in one sentence: the provider is not called on a result
 * nobody understood. So most of these are about what the scanner's silence is
 * allowed to mean, and about the window between clearing bytes and sending
 * them.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  INADMISSIBLE_TOOLS,
  REFUSALS,
  SCAN_RESULTS,
  SELF_TEST_TOKEN,
  assertManifestCarriesNoSecret,
  assertSendMatches,
  classifyAttachment,
  classifyScan,
  clearForDispatch,
  digestOf,
  exceptionApplies,
  redact,
  runSelfTest,
} from "../src/host/clearance.mjs";

const code = (name) => (error) => error.code === name;

const SECRET = "ghp_realtokenwouldlooklikethis000000000";

/** A scanner that actually looks at the bytes it is given. */
function scanner(overrides = {}) {
  return {
    tool: "gitleaks",
    version: "8.28.0",
    config_digest: "a".repeat(64),
    scan(body) {
      const findings = [];
      if (body.includes(SELF_TEST_TOKEN)) findings.push({ rule: "planted" });
      if (/ghp_[A-Za-z0-9]{20,}/u.test(body)) findings.push({ rule: "github-pat" });
      return { launched: true, exit_code: findings.length > 0 ? 1 : 0, findings };
    },
    ...overrides,
  };
}

const dispatch = {
  dispatch_id: "disp-1",
  attempt: 1,
  artifact_identity: "b".repeat(64),
  candidate_identity: "c".repeat(64),
  anchor_version: 3,
  included_sources: [{ logical_id: "brief", sha256: "d".repeat(64) }],
  serialized_at: "2026-09-08T15:00:00.000Z",
};

const review = { state: "reviewed", disposition: "clear", reviewer: "owner" };

const BODY = "review this change to the store adapter, under /home/operator/project/src";

function clear(overrides = {}) {
  return clearForDispatch({
    body: BODY,
    dispatch,
    scanner: scanner(),
    personalDataReview: review,
    home: "/home/operator",
    ...overrides,
  });
}

test("a clean body clears, and the manifest describes what will be sent", () => {
  const { manifest, body } = clear();
  assert.equal(manifest.sanitized_body_sha256, digestOf(body));
  assert.equal(manifest.scanner.result, "clean");
  assert.equal(manifest.scanner.self_test.state, "passed");
  assert.equal(assertSendMatches(manifest, body), true);
});

test("the scanner must find a planted token before its silence means anything", () => {
  // A scanner that cannot find a planted secret is not evidence that there is
  // none.
  const blind = scanner({ scan: () => ({ launched: true, exit_code: 0, findings: [] }) });
  assert.equal(runSelfTest(blind).state, "failed");
  assert.throws(() => clear({ scanner: blind }), code("clearance_scanner_selftest_failed"));
  assert.equal(runSelfTest(scanner()).planted_token_detected, true);
});

test("unknown is never clean", () => {
  // A launch failure, a non-zero exit that is not a finding, a malformed report
  // and a timeout are all the same answer: nobody understood the result.
  assert.equal(classifyScan({ launched: false }), "unknown");
  assert.equal(classifyScan({ launched: true, timed_out: true, findings: [] }), "unknown");
  assert.equal(classifyScan({ launched: true, malformed: true, findings: [] }), "unknown");
  assert.equal(classifyScan({ launched: true, exit_code: 2, findings: [] }), "unknown");
  assert.equal(classifyScan({ launched: true, exit_code: 0 }), "unknown");
  assert.equal(classifyScan({ launched: true, exit_code: 0, findings: [] }), "clean");
  assert.equal(classifyScan({ launched: true, exit_code: 1, findings: [{ rule: "x" }] }), "findings");
  assert.deepEqual(SCAN_RESULTS.slice(), ["clean", "findings", "unknown"]);
});

test("a dispatch is refused on a result nobody understood, on either pass", () => {
  // Separated deliberately: a scanner that fails on both passes would let one
  // of the two checks be removed without any test noticing.
  const selfTestOk = (body) => {
    if (body.includes(SELF_TEST_TOKEN)) return { launched: true, exit_code: 1, findings: [{ rule: "planted" }] };
    if (body === "nothing interesting here at all") return { launched: true, exit_code: 0, findings: [] };
    return null;
  };
  const failsFirstPass = scanner({
    scan(body) {
      return selfTestOk(body) ?? (body === BODY ? { launched: false } : { launched: true, exit_code: 0, findings: [] });
    },
  });
  assert.throws(() => clear({ scanner: failsFirstPass }), code("clearance_scanner_unknown_result"));

  const failsRescan = scanner({
    scan(body) {
      return (
        selfTestOk(body) ??
        (body.includes("<home>") ? { launched: true, timed_out: true, findings: [] } : { launched: true, exit_code: 0, findings: [] })
      );
    },
  });
  assert.throws(() => clear({ scanner: failsRescan }), code("clearance_scanner_unknown_result"));
});

test("a body carrying a secret does not clear", () => {
  assert.throws(() => clear({ body: `${BODY}\ntoken: ${SECRET}` }), code("clearance_secret_found"));
});

test("no scanner at all is not a clearance", () => {
  assert.throws(() => clear({ scanner: undefined }), code("clearance_scanner_missing"));
  assert.throws(() => clear({ scanner: { tool: "x", scan: undefined } }), code("clearance_scanner_missing"));
});

test("a keyword grep is a signal and never the evidence", () => {
  for (const tool of INADMISSIBLE_TOOLS) {
    assert.throws(() => clear({ scanner: scanner({ tool }) }), code("clearance_keyword_grep_as_evidence"));
  }
});

test("personal data is a separate question from secrets", () => {
  // A secret scanner looks for credentials, and a client name is none of those.
  assert.throws(
    () => clear({ personalDataReview: { state: "not_reviewed" } }),
    code("clearance_personal_data_unreviewed"),
  );
  // A disposition without the review that produced it is the interesting case:
  // "clear" asserted by nobody.
  assert.throws(
    () => clear({ personalDataReview: { state: "not_reviewed", disposition: "clear" } }),
    code("clearance_personal_data_unreviewed"),
  );
  assert.throws(
    () => clear({ personalDataReview: { state: "reviewed", disposition: "personal_data_present" } }),
    code("clearance_personal_data_unreviewed"),
  );
});

test("an exception covers the exact current scope and never becomes standing", () => {
  const exception = {
    dispatch_id: dispatch.dispatch_id,
    attempt: dispatch.attempt,
    candidate_identity: dispatch.candidate_identity,
    approved_by: "owner",
  };
  assert.equal(exceptionApplies(exception, dispatch), true);
  const withData = { state: "reviewed", disposition: "personal_data_present" };
  assert.doesNotThrow(() => clear({ personalDataReview: withData, exception }));
  for (const drift of [
    { attempt: 2 },
    { candidate_identity: "9".repeat(64) },
    { dispatch_id: "disp-2" },
  ]) {
    assert.equal(exceptionApplies({ ...exception, ...drift }, dispatch), false);
    assert.throws(
      () => clear({ personalDataReview: withData, exception: { ...exception, ...drift } }),
      code("clearance_exception_stale"),
    );
  }
  assert.equal(exceptionApplies(undefined, dispatch), false);
});

test("a binary or non-UTF-8 attachment needs its own classification", () => {
  // A scanner reading it as text proves nothing.
  assert.equal(classifyAttachment({ binary: true, encoding: "utf-8" }), "requires_snapshot_policy");
  assert.equal(classifyAttachment({ binary: false, encoding: "latin1" }), "requires_snapshot_policy");
  assert.equal(classifyAttachment({ binary: false, encoding: "utf-8" }), "text");
  assert.throws(
    () => clear({ attachments: [{ id: "screenshot.png", binary: true, encoding: "binary" }] }),
    code("clearance_binary_unclassified"),
  );
  assert.doesNotThrow(() =>
    clear({ attachments: [{ id: "screenshot.png", binary: true, encoding: "binary", snapshot_ref: "snap-1" }] }),
  );
});

test("absolute home paths are redacted, and the redaction is recorded without the value", () => {
  const { manifest, body } = clear();
  assert.ok(!body.includes("/home/operator"));
  assert.ok(body.includes("<home>"));
  assert.ok(manifest.redactions.some((entry) => entry.reason === "absolute_home_path"));
  const { redactions } = redact("no home here", { home: "/home/operator" });
  assert.deepEqual(redactions, []);
  // A one-character home is not a home. Replacing "/" everywhere would rewrite
  // every path in the body and record it as a redaction, which is the opposite
  // of what a reader would take the manifest to mean.
  const slash = redact("/etc/hosts and /var/log", { home: "/" });
  assert.equal(slash.body, "/etc/hosts and /var/log");
  assert.deepEqual(slash.redactions, []);
});

test("the manifest never quotes what it removed", () => {
  // A record of what was found that quotes what was found has moved the secret
  // into a file kept longer and read more widely than the prompt ever was.
  const { manifest } = clear({
    body: `${BODY} ${SECRET}`,
    dispatch: {
      ...dispatch,
      replacements: [{ find: SECRET, replaceWith: "<redacted:token>", reason: "credential" }],
    },
  });
  assert.doesNotThrow(() => assertManifestCarriesNoSecret(manifest, [SECRET]));
  assert.throws(
    () => assertManifestCarriesNoSecret({ ...manifest, note: `found ${SECRET}` }, [SECRET]),
    code("clearance_manifest_contains_secret"),
  );
});

test("the re-scan is after redaction, because the bytes are what was vouched for", () => {
  // A body that only becomes clean through redaction still clears, and the
  // manifest describes the redacted bytes rather than the original.
  const { manifest, body } = clear({
    body: `${BODY} ${SECRET}`,
    dispatch: {
      ...dispatch,
      replacements: [{ find: SECRET, replaceWith: "<redacted:token>", reason: "credential" }],
    },
  });
  assert.ok(!body.includes(SECRET));
  assert.equal(manifest.scanner.scanned_sha256, digestOf(body));
  assert.notEqual(manifest.sanitized_body_sha256, digestOf(`${BODY} ${SECRET}`));
});

test("the send layer checks the digest again, and a byte changed in between is caught", () => {
  // The window between clearing and sending is exactly where a source mutation
  // lands.
  const { manifest, body } = clear();
  assert.throws(() => assertSendMatches(manifest, `${body} `), code("clearance_digest_mismatch"));
  // A change that keeps the size identical is the one a size check alone misses.
  const sameSize = `${body.slice(0, -1)}X`;
  assert.equal(Buffer.byteLength(sameSize, "utf8"), manifest.sanitized_body_size);
  assert.throws(() => assertSendMatches(manifest, sameSize), code("clearance_digest_mismatch"));
  assert.throws(
    () => assertSendMatches({ ...manifest, sanitized_body_size: manifest.sanitized_body_size + 1 }, body),
    code("clearance_digest_mismatch"),
  );
});

test("every refusal class the contract closes can be produced", () => {
  const produced = new Set();
  const attempts = [
    () => clear({ scanner: undefined }),
    () => clear({ scanner: scanner({ scan: () => ({ launched: true, exit_code: 0, findings: [] }) }) }),
    () =>
      clear({
        scanner: scanner({
          scan(body) {
            if (body.includes(SELF_TEST_TOKEN)) return { launched: true, exit_code: 1, findings: [{}] };
            if (body === "nothing interesting here at all") return { launched: true, exit_code: 0, findings: [] };
            return { launched: false };
          },
        }),
      }),
    () => clear({ body: `${BODY} ${SECRET}` }),
    () => clear({ personalDataReview: { state: "not_reviewed" } }),
    () => assertSendMatches(clear().manifest, "different bytes"),
    () => assertManifestCarriesNoSecret({ note: SECRET }, [SECRET]),
    () =>
      clear({
        personalDataReview: { state: "reviewed", disposition: "personal_data_present" },
        exception: { dispatch_id: "other", attempt: 1, candidate_identity: dispatch.candidate_identity },
      }),
    () => clear({ attachments: [{ id: "a.bin", binary: true, encoding: "binary" }] }),
    () => clear({ scanner: scanner({ tool: "grep" }) }),
  ];
  for (const attempt of attempts) {
    try {
      attempt();
    } catch (error) {
      produced.add(error.code);
    }
  }
  for (const refusal of REFUSALS) {
    assert.ok(produced.has(refusal), `${refusal} is documented and never produced`);
  }
});
