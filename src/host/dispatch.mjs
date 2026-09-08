/** The send path: compile, clear, budget, send, verify the echo (#19, #20).
 *
 * Three contracts meet at the moment bytes leave this machine, and each of them
 * is about the same instant. #19 says the receiver must be able to say what it
 * read; #20 says the exact bytes about to be sent were scanned; and the budget
 * is about the payload that is actually transmitted rather than the fragments
 * that were assembled.
 *
 * The order is the point. Compile, then clear the compiled bytes, then check
 * that what is about to be written is what was cleared, then send. Clearing a
 * draft and sending an assembled version is the failure that reads like a
 * process.
 *
 * Injected `send(payload, { timeoutMs })` returns `{ code, stdout, stderr }`.
 * `envelope` builds the transmitted payload; a transport with its own format
 * supplies its own, and is held to the same check as the built-in one.
 */
import { createHash } from 'node:crypto';

import { demand, immutable } from '../runtime/contracts.mjs';

import { assertSendMatches, classifyScan, clearForDispatch, redact } from './clearance.mjs';
import { boundDiagnostics } from './provider-preflight.mjs';
import { compileCarrier, verifyEcho } from './stage-carrier.mjs';

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * A secret scanner over the exact serialized bytes.
 *
 * Rules, a version and a config digest, because a scanner whose configuration
 * nobody recorded cleared bytes under rules nobody can reconstruct. Its
 * findings are structured: the clearance decides what they mean, and this
 * decides nothing.
 */
export const SCANNER_RULES = immutable([
  // Patterns as source text, not compiled objects: the rule set is data the
  // config digest can be taken over, and a shared compiled regex would carry
  // `lastIndex` from one scan into the next.
  { id: 'aws_access_key', source: '\\bAKIA[0-9A-Z]{12,}\\b', flags: 'gu' },
  { id: 'github_token', source: '\\bgh[pousr]_[A-Za-z0-9]{16,}\\b', flags: 'gu' },
  { id: 'github_pat', source: '\\bgithub_pat_[A-Za-z0-9_]{20,}\\b', flags: 'gu' },
  { id: 'private_key', source: '-----BEGIN [A-Z ]*PRIVATE KEY-----', flags: 'gu' },
  { id: 'bearer_token', source: '\\bBearer\\s+[A-Za-z0-9._~+/-]{20,}=*', flags: 'gu' },
  {
    id: 'labelled_secret',
    source: '\\b(?:api[_-]?key|secret|password|token)\\s*[:=]\\s*["\']?[A-Za-z0-9._~+/-]{12,}',
    flags: 'giu',
  },
]);

/** The scanner adapter the clearance is given. */
export function secretScanner({ rules = SCANNER_RULES } = {}) {
  const config_digest = sha256(rules.map((rule) => `${rule.id}=${rule.source}/${rule.flags}`).join('\n'));
  return Object.freeze({
    tool: 'autosk-flow-secret-scan',
    version: '1',
    config_digest,
    scan(text) {
      const findings = [];
      for (const rule of rules) {
        // Compiled per scan: a shared global pattern carries `lastIndex`
        // between calls, and a scanner that skips the start of every second
        // body is the kind of silence this contract exists to distrust.
        const pattern = new RegExp(rule.source, rule.flags);
        for (const match of String(text).matchAll(pattern)) {
          findings.push({ rule: rule.id, at: match.index });
        }
      }
      return { exit_code: findings.length === 0 ? 0 : 1, findings };
    },
  });
}

/**
 * The payload as it will actually be transmitted.
 *
 * Budgeted on these bytes, not on the fragments: the envelope is part of what
 * the receiver has to hold, and a budget that ignores it is a budget for
 * something else.
 */
export function payloadFor({ compiled, route, dispatch }) {
  const envelope = [
    `dispatch_id=${dispatch.dispatch_id}`,
    `attempt=${dispatch.attempt}`,
    `role=${dispatch.role ?? ''}`,
    `stage=${dispatch.stage ?? ''}`,
    `model=${route.model_id}`,
    `effort=${route.requested_effort}`,
  ].join('\n');
  const payload = `${envelope}\n@@@\n${compiled.body}`;
  return Object.freeze({
    payload,
    size: Buffer.byteLength(payload, 'utf8'),
    envelope_size: Buffer.byteLength(`${envelope}\n@@@\n`, 'utf8'),
    body_size: compiled.size,
  });
}

/** What the budget says about the payload that is actually going out. */
export function budgetErrors(measured, budget) {
  const errors = [];
  if (measured.size > budget.max_bytes) {
    errors.push({
      reason: 'carrier_budget_exceeded',
      detail: `${measured.size} bytes over a ${budget.max_bytes} budget, of which ${measured.envelope_size} is envelope`,
    });
  }
  return errors;
}

/**
 * The send path.
 *
 * Nothing here re-decides a refusal: the carrier is #19's, the clearance is
 * #20's, and this is the order they run in plus the one thing neither can do
 * alone — checking that the bytes handed to the transport are the bytes that
 * were cleared, at the moment they are handed over.
 */
export async function dispatchCarrier(send, {
  registry,
  bundle,
  anchors,
  route,
  dispatch,
  context,
  scanner,
  personalDataReview,
  attachments = [],
  home,
  exception,
  envelope = payloadFor,
  timeouts = { wall_clock_ms: 30_000 },
}) {
  // One scanner for both directions: the bytes going out and the diagnostics
  // coming back are held to the same rules, and two resolutions could drift.
  const secretScan = scanner ?? secretScanner();
  const compiled = compileCarrier(registry, {
    role: dispatch.role,
    stage: dispatch.stage,
    context,
    bundle,
    anchors,
  });

  const cleared = clearForDispatch({
    body: compiled.body,
    dispatch,
    scanner: secretScan,
    personalDataReview,
    attachments,
    home,
    exception,
  });

  // The cleared bytes are what goes into the payload. Assembling a different
  // body after clearance is the failure that reads like a process.
  const clearedCompiled = Object.freeze({ ...compiled, body: cleared.body });
  const measured = envelope({ compiled: clearedCompiled, route, dispatch });
  // Checked against the payload, not against the variable that was just
  // assigned: the envelope is where a transport re-encodes, truncates or
  // normalises, and comparing the cleared body to itself would prove nothing.
  assertSendMatches(cleared.manifest, measured.payload.slice(measured.envelope_size));
  const overBudget = budgetErrors(measured, registry.budget);
  demand(overBudget.length === 0, 'carrier_budget_exceeded', 'The payload does not fit the fixed budget',
    { detail: overBudget[0]?.detail });

  const result = await send(measured.payload, { timeoutMs: timeouts.wall_clock_ms });
  // What came back is held to the contract the outgoing bytes were held to. A
  // provider that quotes a credential in its error message would otherwise put
  // it in the record that the outgoing scan was there to keep it out of.
  const diagnostics = sanitizeDiagnostics(result.stderr, {
    home,
    replacements: dispatch.replacements,
    scanner: secretScan,
  });
  return Object.freeze({
    dispatch_id: dispatch.dispatch_id,
    attempt: dispatch.attempt,
    key: compiled.key,
    sent_sha256: sha256(measured.payload),
    sent_bytes: measured.size,
    headers: compiled.headers,
    clearance: cleared.manifest,
    exit_code: result.code,
    stdout: result.stdout ?? '',
    stderr: diagnostics.text,
    diagnostics: diagnostics.record,
  });
}

/**
 * Provider diagnostics, held to the same sanitization contract as the request.
 *
 * Redacted first, then scanned, and a finding that survives is replaced rather
 * than recorded: the diagnostic is worth keeping and its bytes are not, and
 * "the provider said it, not us" does not make a leaked credential less leaked.
 */
export function sanitizeDiagnostics(text, { home, replacements = [], scanner }) {
  const { body, redactions } = redact(typeof text === 'string' ? text : '', { home, replacements });
  const bounded = boundDiagnostics(body, { home });
  const scan = classifyScan(scanner.scan(bounded));
  if (scan === 'clean') {
    return Object.freeze({
      text: bounded,
      record: Object.freeze({ scan, redactions: immutable(redactions), withheld: false }),
    });
  }
  return Object.freeze({
    text: '<withheld: provider diagnostics carried a finding>',
    record: Object.freeze({ scan, redactions: immutable(redactions), withheld: true }),
  });
}

/**
 * What the receiver said it read.
 *
 * An echo is the only evidence that the fragment the provider used is the
 * fragment that was sent; a response with none is not a response about this
 * carrier.
 */
export function echoErrors(record, attributions) {
  return immutable(verifyEcho(record.headers, attributions ?? []).map(Object.freeze));
}
