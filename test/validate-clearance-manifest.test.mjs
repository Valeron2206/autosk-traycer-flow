/**
 * Tests for the issue #20 clearance manifest.
 *
 * Three things must be impossible: a scan of something other than what will be
 * sent, a scanner whose silence was read as a pass, and a manifest that quotes
 * what it found.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  BLOCKED_EXAMPLE_PATH,
  CONTRACT_PATH,
  EXAMPLE_PATH,
  REFUSALS,
  SCHEMA_PATH,
  clearanceDesignDigest,
  dispatchDecision,
  loadFiles,
  manifestQuotesASecret,
  validateClearanceManifestDesign,
  validateManifest,
} from "../scripts/validate-clearance-manifest.mjs";

const files = loadFiles();
const schema = JSON.parse(files[SCHEMA_PATH]);

const cleared = () => JSON.parse(files[EXAMPLE_PATH]);
const blocked = () => JSON.parse(files[BLOCKED_EXAMPLE_PATH]);

function mutated(mutate, base = cleared) {
  const value = base();
  mutate(value);
  return value;
}

test("the shipped design validates", () => {
  assert.deepEqual(validateClearanceManifestDesign(files), []);
});

test("the two examples land on opposite sides", () => {
  assert.equal(dispatchDecision(cleared()), "cleared");
  assert.notEqual(dispatchDecision(blocked()), "cleared");
});

test("an unknown scanner result is not a pass", () => {
  // The whole shape of the issue: the provider is not called on a result nobody
  // understood. A launch failure, a strange exit, a malformed report and a
  // timeout are all this.
  assert.equal(
    dispatchDecision(
      mutated((value) => {
        value.scanner.result = "unknown";
        delete value.scanner.finding_count;
      }),
    ),
    "refused:clearance_scanner_unknown_result",
  );
});

test("a scanner that cannot find a planted secret clears nothing", () => {
  for (const break_ of [
    (value) => {
      value.scanner.self_test.state = "failed";
    },
    (value) => {
      value.scanner.self_test.planted_token_detected = false;
    },
    (value) => {
      value.scanner.self_test.clean_fixture_exit = 1;
    },
  ]) {
    assert.equal(dispatchDecision(mutated(break_)), "refused:clearance_scanner_selftest_failed");
  }
});

test("a keyword grep is never the evidence that clears a dispatch", () => {
  assert.equal(
    dispatchDecision(
      mutated((value) => {
        value.scanner.keyword_grep_only = true;
      }),
    ),
    "refused:clearance_keyword_grep_as_evidence",
  );
});

test("the bytes that were scanned must be the bytes that will be sent", () => {
  // The window between clearing and sending is exactly where a source mutation
  // lands, so the send layer compares digests rather than assuming.
  assert.equal(
    dispatchDecision(
      mutated((value) => {
        value.sanitized_body_sha256 = "9".repeat(64);
      }),
    ),
    "refused:clearance_digest_mismatch",
  );
});

test("findings block, and a clean result cannot carry findings", () => {
  assert.equal(
    dispatchDecision(
      mutated((value) => {
        value.scanner.result = "findings";
        value.scanner.finding_count = 2;
      }),
    ),
    "refused:clearance_secret_found",
  );
  const errors = validateManifest(
    mutated((value) => {
      value.scanner.finding_count = 3;
    }),
    schema,
  );
  assert.ok(errors.some((message) => /clean result cannot carry findings/u.test(message)));
});

test("personal data is a separate gate a secret scanner cannot satisfy", () => {
  // A client name or an account id is not a credential, so a clean scan says
  // nothing about it.
  for (const state of ["unreviewed", "blocked"]) {
    assert.equal(
      dispatchDecision(
        mutated((value) => {
          value.personal_data_review = { state };
        }),
      ),
      "refused:clearance_personal_data_unreviewed",
    );
  }
});

test("an unclassified attachment blocks, because reading a binary as text proves nothing", () => {
  assert.equal(
    dispatchDecision(
      mutated((value) => {
        delete value.included_sources[0].classification;
      }),
    ),
    "refused:clearance_binary_unclassified",
  );
});

test("an exception applies to its exact scope and nothing else", () => {
  const scoped = mutated((value) => {
    value.exception = {
      approved_by: "owner",
      scope_dispatch_id: value.dispatch_id,
      scope_candidate_identity: value.candidate_identity,
      reason: "the client name is the subject of the task",
    };
  });
  assert.equal(dispatchDecision(scoped), "cleared");
  // A stale exception — one from another dispatch — does not carry over.
  const stale = mutated((value) => {
    value.exception = {
      approved_by: "owner",
      scope_dispatch_id: "dispatch-older",
      scope_candidate_identity: value.candidate_identity,
      reason: "approved once",
    };
  });
  assert.equal(dispatchDecision(stale), "refused:clearance_exception_stale");
});

test("the manifest does not quote what it found", () => {
  // A record that quotes the secret has moved it into a file kept longer and
  // read more widely than the prompt ever was.
  assert.equal(manifestQuotesASecret(cleared()), false);
  for (const planted of [
    "ghp_0123456789abcdefghijklmnopqrstuvwx",
    "sk-0123456789abcdefghijklmnop",
    "AKIAIOSFODNN7EXAMPLE",
    "-----BEGIN RSA PRIVATE KEY-----",
    "xoxb-1234567890-abcdefghij",
  ]) {
    const leaked = mutated((value) => {
      value.redactions.push({ fragment_id: planted, reason: "secret" });
    });
    assert.equal(manifestQuotesASecret(leaked), true, `${planted} was not noticed`);
    assert.ok(
      validateManifest(leaked, schema).some((message) => /clearance_manifest_contains_secret/u.test(message)),
    );
  }
});

test("a redaction record has no field for what it redacted", () => {
  // Stronger than a rule against writing one.
  const props = Object.keys(schema.properties.redactions.items.properties);
  assert.ok(!props.includes("value") && !props.includes("matched_text"));
  assert.equal(schema.properties.redactions.items.additionalProperties, false);
});

test("an ignored tracked file is ordinary tracked content", () => {
  // `.gitignore` is not a protection boundary, and treating it as one is how an
  // ignored-but-tracked secret ships.
  assert.ok(files[CONTRACT_PATH].includes("`.gitignore` is not a protection boundary"));
});

test("every refusal is documented", () => {
  const contract = files[CONTRACT_PATH];
  for (const refusal of REFUSALS) assert.ok(contract.includes(refusal), `${refusal} is not documented`);
});

test("the design digest changes when any shipped file changes", () => {
  const before = clearanceDesignDigest(files);
  const after = clearanceDesignDigest({ ...files, [CONTRACT_PATH]: `${files[CONTRACT_PATH]}\n` });
  assert.notEqual(before, after);
});
