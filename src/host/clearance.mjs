/** Clearance: what must be true before a single byte reaches a provider.
 *
 * Scanning the source files before the prompt is compiled does not establish
 * that the prompt is safe. Dangerous fragments appear when fragments are
 * joined, when a template substitutes, and in diagnostics and attribution that
 * no source file contains. So the scan is of the exact serialized bytes.
 *
 * The scanner's own failure is never read as a pass, and the send layer checks
 * the digest again immediately before the call — the window between clearing
 * bytes and sending them is exactly where a source mutation lands.
 */
import { createHash } from 'node:crypto';

import { demand, immutable } from '../runtime/contracts.mjs';

export const REFUSALS = immutable([
  'clearance_scanner_missing',
  'clearance_scanner_selftest_failed',
  'clearance_scanner_unknown_result',
  'clearance_secret_found',
  'clearance_personal_data_unreviewed',
  'clearance_digest_mismatch',
  'clearance_manifest_contains_secret',
  'clearance_exception_stale',
  'clearance_binary_unclassified',
  'clearance_keyword_grep_as_evidence',
]);

/** A scanner result is one of these. `unknown` is not a shade of clean. */
export const SCAN_RESULTS = immutable(['clean', 'findings', 'unknown']);

/** Tools that are a signal and never the evidence that clears a dispatch. */
export const INADMISSIBLE_TOOLS = immutable(['grep', 'ripgrep', 'rg', 'keyword-grep']);

/** The planted token the self-test looks for. High entropy and obviously fake. */
export const SELF_TEST_TOKEN = 'AKIAZZ7EXAMPLEPLANTED42';

export const digestOf = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * Runs the scanner self-test.
 *
 * A scanner that cannot find a planted secret is not evidence that there is
 * none, so this runs once per tool, version, config and environment, and its
 * failure stops the dispatch rather than being noted.
 */
export function runSelfTest(scanner) {
  const planted = scanner.scan(`prefix ${SELF_TEST_TOKEN} suffix`);
  const clean = scanner.scan('nothing interesting here at all');
  // Classified the same way a real scan is: one place decides what an
  // invocation means, so a self-test cannot pass under a looser reading than
  // the scan it vouches for.
  const state = classifyScan(planted) === 'findings' && classifyScan(clean) === 'clean' ? 'passed' : 'failed';
  return Object.freeze({
    state,
    planted_token_detected: classifyScan(planted) === 'findings',
    clean_fixture_exit: clean.exit_code ?? 0,
  });
}

/**
 * Classifies a scanner invocation.
 *
 * A launch failure, a non-zero exit that is not a finding, a malformed report
 * or a timeout is `unknown` — never `clean`. This is the whole shape of the
 * issue: the provider is not called on a result nobody understood.
 */
export function classifyScan(invocation) {
  if (invocation.launched === false) return 'unknown';
  if (invocation.timed_out) return 'unknown';
  if (invocation.malformed) return 'unknown';
  if (invocation.findings === undefined) return 'unknown';
  if (invocation.exit_code !== 0 && invocation.findings.length === 0) return 'unknown';
  return invocation.findings.length > 0 ? 'findings' : 'clean';
}

/** Is this fragment safe to send as text at all? */
export function classifyAttachment(attachment) {
  if (attachment.binary || attachment.encoding !== 'utf-8') return 'requires_snapshot_policy';
  return 'text';
}

/**
 * Deterministic redactions over the serialized body.
 *
 * Absolute home and user paths become logical locators, because a path looks
 * like context and carries a username. The result is returned rather than
 * applied in place: the caller re-serializes and re-scans, since a redaction
 * changes the bytes and the bytes are what was being vouched for.
 */
export function redact(body, { home, replacements = [] } = {}) {
  let text = body;
  const applied = [];
  if (home && home.length > 1 && text.includes(home)) {
    text = text.split(home).join('<home>');
    applied.push({ reason: 'absolute_home_path', locator: '<home>' });
  }
  for (const { find, replaceWith, reason } of replacements) {
    if (!text.includes(find)) continue;
    text = text.split(find).join(replaceWith);
    applied.push({ reason, locator: replaceWith });
  }
  return { body: text, redactions: applied };
}

/** No secret value appears in the manifest, including inside a redaction note. */
export function assertManifestCarriesNoSecret(manifest, secretValues) {
  const serialized = JSON.stringify(manifest);
  for (const secret of secretValues) {
    // A record of what was found that quotes what was found has moved the
    // secret rather than removed it — into a file kept longer and read more
    // widely than the prompt ever was.
    demand(!serialized.includes(secret), 'clearance_manifest_contains_secret',
      'The manifest quotes a value it was supposed to remove');
  }
  return manifest;
}

/** An exception covers the exact current scope, and never becomes standing. */
export function exceptionApplies(exception, dispatch) {
  if (!exception) return false;
  return exception.dispatch_id === dispatch.dispatch_id
    && exception.attempt === dispatch.attempt
    && exception.candidate_identity === dispatch.candidate_identity;
}

/**
 * Clears a compiled body for dispatch, or refuses.
 *
 * The order is the guarantee: serialize, self-test, scan, personal-data check,
 * redact, re-serialize, re-scan, record. Each step is after the one before it
 * for a reason, and skipping one leaves a claim about bytes that were never
 * the bytes that would be sent.
 */
export function clearForDispatch({ body, dispatch, scanner, personalDataReview, attachments = [], home, exception }) {
  demand(scanner && typeof scanner.scan === 'function', 'clearance_scanner_missing',
    'No scanner is configured; a dispatch is not cleared by the absence of one');
  demand(!INADMISSIBLE_TOOLS.includes(scanner.tool), 'clearance_keyword_grep_as_evidence',
    'A keyword grep is an extra signal, never the evidence that clears a dispatch',
    { tool: scanner.tool });

  const selfTest = runSelfTest(scanner);
  demand(selfTest.state === 'passed', 'clearance_scanner_selftest_failed',
    'The scanner did not find a planted token, so its silence proves nothing');

  for (const attachment of attachments) {
    demand(classifyAttachment(attachment) === 'text' || Boolean(attachment.snapshot_ref),
      'clearance_binary_unclassified',
      'A binary or non-UTF-8 attachment needs its own classification and snapshot',
      { id: attachment.id });
  }

  const firstPass = classifyScan(scanner.scan(body));
  demand(firstPass !== 'unknown', 'clearance_scanner_unknown_result',
    'The scanner result was not understood, and unknown is not clean');

  // Personal data is its own question: a secret scanner looks for credentials,
  // and a client name is none of those.
  demand(personalDataReview?.state === 'reviewed', 'clearance_personal_data_unreviewed',
    'The personal and client-data review has not been made');
  // A presented exception is checked for staleness first, so the refusal names
  // the actual problem: "an exception that no longer applies" is a different
  // thing to fix from "nobody reviewed this".
  if (exception) {
    demand(exceptionApplies(exception, dispatch), 'clearance_exception_stale',
      'The exception was approved for another dispatch, attempt or candidate');
  }
  demand(personalDataReview.disposition === 'clear' || exceptionApplies(exception, dispatch),
    'clearance_personal_data_unreviewed',
    'Personal or client data is present without an approved exception for this dispatch');

  const { body: sanitized, redactions } = redact(body, { home, replacements: dispatch.replacements });
  const secondPass = classifyScan(scanner.scan(sanitized));
  demand(secondPass !== 'unknown', 'clearance_scanner_unknown_result',
    'The re-scan after redaction was not understood');
  demand(secondPass === 'clean', 'clearance_secret_found',
    'The bytes that would be sent still contain a finding');

  const manifest = {
    schema_version: 1,
    dispatch_id: dispatch.dispatch_id,
    attempt: dispatch.attempt,
    artifact_identity: dispatch.artifact_identity,
    candidate_identity: dispatch.candidate_identity,
    anchor_version: dispatch.anchor_version,
    included_sources: dispatch.included_sources,
    redactions,
    scanner: {
      tool: scanner.tool,
      version: scanner.version,
      config_digest: scanner.config_digest,
      self_test: selfTest,
      result: secondPass,
      scanned_sha256: digestOf(sanitized),
    },
    personal_data_review: personalDataReview,
    sanitized_body_sha256: digestOf(sanitized),
    sanitized_body_size: Buffer.byteLength(sanitized, 'utf8'),
    serialized_at: dispatch.serialized_at,
    ...(exception ? { exception } : {}),
  };
  return { manifest: Object.freeze(manifest), body: sanitized };
}

/**
 * The send layer's last check.
 *
 * Recomputes the digest of what it is about to send and compares it with the
 * manifest. Anything else means the bytes that were cleared and the bytes that
 * are sent were only assumed to be the same.
 */
export function assertSendMatches(manifest, bytesAboutToBeSent) {
  const actual = digestOf(bytesAboutToBeSent);
  demand(actual === manifest.sanitized_body_sha256, 'clearance_digest_mismatch',
    'The bytes about to be sent are not the bytes that were cleared',
    { cleared: manifest.sanitized_body_sha256, sending: actual });
  demand(Buffer.byteLength(bytesAboutToBeSent, 'utf8') === manifest.sanitized_body_size,
    'clearance_digest_mismatch', 'The size does not match the cleared body');
  return true;
}
