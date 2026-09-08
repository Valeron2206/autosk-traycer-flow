/**
 * Tests for the send path (issues #19 and #20).
 *
 * Three contracts meet at the moment bytes leave this machine. The carrier says
 * the receiver must be able to name what it read, the clearance says the exact
 * bytes were scanned, and the budget is about the payload actually transmitted.
 * What is tested here is the order they run in, and the one thing none of them
 * can do alone: checking that the bytes handed to the transport are the bytes
 * that were cleared.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { parseResult } from "../scripts/fake-provider.mjs";
import { ROOT } from "../scripts/clean-room-e2e.mjs";
import { SELF_TEST_TOKEN, runSelfTest } from "../src/host/clearance.mjs";
import {
  SCANNER_RULES,
  budgetErrors,
  dispatchCarrier,
  echoErrors,
  payloadFor,
  secretScanner,
} from "../src/host/dispatch.mjs";

const execFileAsync = promisify(execFile);
const code = (name) => (error) => error.code === name;
const PROVIDER = path.join(ROOT, "scripts/fake-provider.mjs");
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

/** A provider on the other end of the pipe, receiving the exact payload. */
const sender = (mode) => async (payload, { timeoutMs }) => {
  const child = execFileAsync("node", [PROVIDER, "--mode", mode], { timeout: timeoutMs });
  child.child.stdin.end(payload);
  return child.then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    (error) => ({ code: error.code ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? String(error) }),
  );
};

const FILES = {
  "protocol/review.md": "# Review protocol\nRead the candidate.\n",
  "protocol/rubric.md": "# Rubric\nSeverity levels.\n",
};

const registry = (overrides = {}) => ({
  bundle_digest: "b".repeat(64),
  budget: { max_bytes: 65_536 },
  carriers: {
    "reviewer.review": {
      required: ["protocol/review.md", "protocol/rubric.md"],
      forbidden: [],
      anchors: [],
    },
  },
  ...overrides,
});

const bundle = { read: (file) => FILES[file] };

const context = {
  bundle_digest: "b".repeat(64),
  project: "p-1",
  epic: "e-1",
  task: "ask-a1b2c3",
  dispatch_id: "d-1",
  round: 1,
  attempt: 1,
  serialization_version: 1,
};

const dispatch = (overrides = {}) => ({
  dispatch_id: "d-1",
  attempt: 1,
  role: "reviewer",
  stage: "review",
  artifact_identity: "a".repeat(64),
  candidate_identity: "c".repeat(64),
  anchor_version: 3,
  included_sources: ["protocol/review.md", "protocol/rubric.md"],
  serialized_at: "2026-09-09T10:00:00Z",
  replacements: [],
  ...overrides,
});

const reviewed = { state: "reviewed", disposition: "clear" };

const options = (overrides = {}) => ({
  registry: registry(),
  bundle,
  anchors: {},
  route: { model_id: "fake-model-1", requested_effort: "high" },
  dispatch: dispatch(),
  context,
  personalDataReview: reviewed,
  ...overrides,
});

test("the scanner adapter finds a planted token and stays quiet otherwise", () => {
  const scanner = secretScanner();
  // The clearance refuses to trust a scanner that cannot prove it looks.
  assert.equal(runSelfTest(scanner).state, "passed");
  assert.equal(scanner.tool, "autosk-flow-secret-scan");
  assert.ok(scanner.config_digest.length === 64);
  // Scanning twice gives the same answer: a shared global pattern would carry
  // `lastIndex` and skip the start of the second body.
  const body = `token ${SELF_TEST_TOKEN} here`;
  assert.deepEqual(scanner.scan(body), scanner.scan(body));
  assert.equal(scanner.scan("ghp_" + "A".repeat(36)).findings[0].rule, "github_token");
  assert.equal(scanner.scan("-----BEGIN OPENSSH PRIVATE KEY-----").findings[0].rule, "private_key");
  assert.equal(scanner.scan("api_key = sk-abcdefghijklmnop").findings[0].rule, "labelled_secret");
  assert.equal(SCANNER_RULES.length, 6);
  // The exit status is part of the adapter's contract: the clearance reads
  // "non-zero with no findings" as `unknown`, so a scanner that always exits 0
  // would report a crash as a clean body.
  assert.equal(scanner.scan("nothing here").exit_code, 0);
  assert.equal(scanner.scan(`AKIA${"Z".repeat(16)}`).exit_code, 1);
});

test("a carrier is compiled, cleared and sent, and the receiver names what it read", async () => {
  const record = await dispatchCarrier(sender("echo"), options());
  assert.equal(record.exit_code, 0);
  assert.equal(record.sent_sha256.length, 64);
  assert.equal(record.clearance.scanner.result, "clean");
  assert.equal(record.headers.length, 2);

  const result = parseResult(record.stdout);
  assert.ok(result, record.stdout);
  // The echo is the only evidence that the fragment the provider used is the
  // fragment that was sent.
  assert.deepEqual([...echoErrors(record, result.attributions)], []);
});

test("a response that echoes nothing is not a response about this carrier", async () => {
  const record = await dispatchCarrier(sender("ok"), options());
  const result = parseResult(record.stdout);
  const errors = echoErrors(record, result.attributions);
  assert.ok(errors.some((error) => error.reason === "carrier_echo_missing"));
});

test("an echo that drops a fragment, and one that invents a dispatch, are different faults", async () => {
  const partial = await dispatchCarrier(sender("echo_partial"), options());
  const partialErrors = echoErrors(partial, parseResult(partial.stdout).attributions);
  assert.ok(partialErrors.some((error) => error.reason === "carrier_echo_missing"));

  const foreign = await dispatchCarrier(sender("echo_foreign"), options());
  const foreignErrors = echoErrors(foreign, parseResult(foreign.stdout).attributions);
  // Echoing something that was not sent is a claim about a different dispatch.
  assert.ok(foreignErrors.some((error) => error.reason === "carrier_echo_wrong_scope"));
});

test("the budget is about the payload that is actually transmitted", async () => {
  const compiled = { body: "x".repeat(100), size: 100 };
  const measured = payloadFor({
    compiled,
    route: { model_id: "fake-model-1", requested_effort: "high" },
    dispatch: dispatch(),
  });
  // The envelope is part of what the receiver has to hold, and a budget that
  // ignores it is a budget for something else.
  assert.equal(measured.size, measured.body_size + measured.envelope_size);
  assert.ok(measured.envelope_size > 0);
  assert.deepEqual(budgetErrors(measured, { max_bytes: 65_536 }), []);
  const over = budgetErrors(measured, { max_bytes: measured.body_size });
  assert.ok(over.some((error) => error.reason === "carrier_budget_exceeded"));
  assert.ok(/of which \d+ is envelope/u.test(over[0].detail), over[0].detail);

  // A budget the body fits and the payload does not: the refusal has to come
  // from the send path, not from the compile that never saw the envelope.
  const sized = await dispatchCarrier(sender("ok"), options());
  const bodyOnly = sized.sent_bytes - payloadFor({
    compiled: { body: "", size: 0 },
    route: { model_id: "fake-model-1", requested_effort: "high" },
    dispatch: dispatch(),
  }).envelope_size;
  await assert.rejects(
    () => dispatchCarrier(sender("ok"), options({ registry: registry({ budget: { max_bytes: bodyOnly + 1 } }) })),
    code("carrier_budget_exceeded"),
  );
});

test("a body carrying a secret is never sent", async () => {
  const leaking = {
    read: (file) => (file === "protocol/rubric.md" ? `key: AKIA${"Z".repeat(16)}\n` : FILES[file]),
  };
  let sent = false;
  const watcher = async () => {
    sent = true;
    return { code: 0, stdout: "", stderr: "" };
  };
  await assert.rejects(
    () => dispatchCarrier(watcher, options({ bundle: leaking })),
    code("clearance_secret_found"),
  );
  assert.equal(sent, false);
});

test("the bytes handed to the transport are the bytes that were cleared", async () => {
  let observed = null;
  const capturing = async (payload) => {
    observed = payload;
    return { code: 0, stdout: "", stderr: "" };
  };
  const record = await dispatchCarrier(capturing, options());
  assert.equal(sha256(observed), record.sent_sha256);
  // The cleared body is inside the payload, byte for byte.
  assert.ok(observed.endsWith(FILES["protocol/rubric.md"]), observed.slice(-80));
  assert.equal(record.clearance.sanitized_body_size, record.sent_bytes - payloadFor({
    compiled: { body: "", size: 0 },
    route: { model_id: "fake-model-1", requested_effort: "high" },
    dispatch: dispatch(),
  }).envelope_size);
});

test("what goes out is the redacted body, not the one that was compiled", async () => {
  const home = "/Users/somebody";
  const leaking = {
    read: (file) => (file === "protocol/rubric.md" ? `see ${home}/notes.md for details\n` : FILES[file]),
  };
  let observed = null;
  const capturing = async (payload) => {
    observed = payload;
    return { code: 0, stdout: "", stderr: "" };
  };
  const record = await dispatchCarrier(capturing, options({ bundle: leaking, home }));
  // The redaction happened, and the bytes that left are the redacted ones.
  assert.ok(record.clearance.redactions.some((entry) => entry.reason === "absolute_home_path"));
  assert.ok(!observed.includes(home), observed);
  assert.ok(observed.includes("<home>/notes.md"), observed);
  assert.equal(sha256(observed), record.sent_sha256);
});

test("a transport that re-encodes the cleared body is caught at the boundary", async () => {
  // The envelope is where a transport truncates, re-encodes or normalises, and
  // the check is against the payload rather than against the body that was
  // just cleared.
  const mangling = ({ compiled, route, dispatch: current }) => {
    const built = payloadFor({ compiled, route, dispatch: current });
    return { ...built, payload: `${built.payload.slice(0, -1)}` };
  };
  let sent = false;
  await assert.rejects(
    () => dispatchCarrier(async () => { sent = true; return { code: 0 }; }, options({ envelope: mangling })),
    code("clearance_digest_mismatch"),
  );
  assert.equal(sent, false);
});

test("a dispatch with no scanner, or an unreviewed one, does not leave the machine", async () => {
  let sent = false;
  const watcher = async () => {
    sent = true;
    return { code: 0, stdout: "", stderr: "" };
  };
  await assert.rejects(
    () => dispatchCarrier(watcher, options({ scanner: { tool: "grep", version: "1", scan: () => ({ exit_code: 0 }) } })),
    code("clearance_keyword_grep_as_evidence"),
  );
  await assert.rejects(
    () => dispatchCarrier(watcher, options({ personalDataReview: { state: "not_reviewed" } })),
    code("clearance_personal_data_unreviewed"),
  );
  // A scanner that cannot find a planted token clears nothing by staying quiet.
  await assert.rejects(
    () => dispatchCarrier(watcher, options({
      scanner: { tool: "quiet", version: "1", config_digest: "d", scan: () => ({ exit_code: 0, findings: [] }) },
    })),
    code("clearance_scanner_selftest_failed"),
  );
  assert.equal(sent, false);
});

test("a fragment this key must never receive is refused before anything is scanned", async () => {
  const forbidden = registry({
    carriers: {
      "reviewer.review": {
        required: ["protocol/review.md", "protocol/rubric.md"],
        forbidden: ["protocol/rubric.md"],
        anchors: [],
      },
    },
  });
  let sent = false;
  await assert.rejects(
    () => dispatchCarrier(async () => { sent = true; return { code: 0 }; }, options({ registry: forbidden })),
    code("carrier_forbidden_fragment"),
  );
  assert.equal(sent, false);
});
