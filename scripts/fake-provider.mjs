#!/usr/bin/env node

/**
 * A provider that is not a provider.
 *
 * The clean room forbids a real provider, a network and credentials, and the
 * preflight still has to be exercised against something that behaves like one —
 * including the ways a provider misbehaves, which is the part a real one cannot
 * be asked to do on demand.
 *
 * Every mode is deterministic and offline. `--mode` selects the behaviour;
 * `--effort` is the effort the caller asked for, so the modes that drop it can
 * demonstrate dropping it.
 */

import process from 'node:process';

export const MODES = Object.freeze([
  // Answers exactly what was asked, and says so in a structured result.
  'ok',
  // Accepts the call and quietly uses its own default effort, with a warning
  // in prose — the case that makes a warning worth parsing.
  'drop_effort',
  // Applies the effort but cannot confirm it: no field, no warning.
  'unconfirmable_effort',
  // Prints success and exits 0 with nothing structured.
  'no_result',
  // The credential is not usable.
  'auth_expired',
  // The model this route names is not offered.
  'model_unsupported',
  // Exits non-zero after producing a real result.
  'result_with_nonzero_exit',
  // Never returns.
  'hang',
  // Reads the carrier from stdin and echoes back the attributions it received,
  // which is what makes the echo check a check rather than a formality.
  'echo',
  // Echoes an attribution nobody sent: a claim about a different dispatch.
  'echo_foreign',
  // Echoes only the first attribution, as a provider that dropped a fragment
  // would.
  'echo_partial',
]);

const RESULT_PREFIX = '<<<autosk-result ';
const RESULT_SUFFIX = '>>>';

/** The structured line a caller parses, or null when the mode emits none. */
export function resultLine(payload) {
  return `${RESULT_PREFIX}${JSON.stringify(payload)}${RESULT_SUFFIX}`;
}

/** Parses a provider's stdout back into the result it claims. */
export function parseResult(stdout) {
  const start = stdout.indexOf(RESULT_PREFIX);
  if (start === -1) return null;
  const end = stdout.indexOf(RESULT_SUFFIX, start);
  if (end === -1) return null;
  try {
    return JSON.parse(stdout.slice(start + RESULT_PREFIX.length, end));
  } catch {
    return null;
  }
}

/**
 * The attributions in a carrier body, read back out of the bytes.
 *
 * A provider that echoes what it received is the only way to learn that the
 * fragment it read is the fragment that was sent.
 */
export function readAttributions(body) {
  const attributions = [];
  for (const block of body.split('\n===\n')) {
    const head = block.split('\n---\n')[0];
    const header = {};
    for (const line of head.split('\n')) {
      const at = line.indexOf('=');
      if (at > 0) header[line.slice(0, at)] = line.slice(at + 1);
    }
    if (header.logical_id) attributions.push(header);
  }
  return attributions;
}

/** What a mode prints and exits with. Pure, so the runner can be tested on it. */
export function behaviour(mode, { model = 'fake-model-1', effort = 'high', body = '' } = {}) {
  switch (mode) {
    case 'ok':
      return { stdout: `${resultLine({ model, effort, effort_echoed: true })}\n`, stderr: '', code: 0 };
    case 'drop_effort':
      return {
        stdout: `${resultLine({ model, effort: 'default', effort_echoed: true })}\n`,
        stderr: `warning: unsupported parameter 'effort'; using the default\n`,
        code: 0,
      };
    case 'unconfirmable_effort':
      return { stdout: `${resultLine({ model })}\n`, stderr: '', code: 0 };
    case 'no_result':
      return { stdout: 'all checks passed\n', stderr: '', code: 0 };
    case 'auth_expired':
      return { stdout: '', stderr: 'error: authentication token expired\n', code: 2 };
    case 'model_unsupported':
      return { stdout: '', stderr: `error: model ${model} is not available on this account\n`, code: 3 };
    case 'echo':
      return {
        stdout: `${resultLine({ model, effort, effort_echoed: true, attributions: readAttributions(body) })}\n`,
        stderr: '',
        code: 0,
      };
    case 'echo_foreign': {
      const attributions = readAttributions(body);
      return {
        stdout: `${resultLine({
          model,
          effort,
          effort_echoed: true,
          attributions: [...attributions, { ...(attributions[0] ?? {}), logical_id: 'never-sent.md' }],
        })}\n`,
        stderr: '',
        code: 0,
      };
    }
    case 'echo_partial':
      return {
        stdout: `${resultLine({ model, effort, effort_echoed: true, attributions: readAttributions(body).slice(0, 1) })}\n`,
        stderr: '',
        code: 0,
      };
    case 'result_with_nonzero_exit':
      return { stdout: `${resultLine({ model, effort, effort_echoed: true })}\n`, stderr: 'warning: partial\n', code: 1 };
    default:
      return null;
  }
}

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

if (process.argv[1] && process.argv[1].endsWith('fake-provider.mjs')) {
  const mode = argument('mode', 'ok');
  const model = argument('model', 'fake-model-1');
  const effort = argument('effort', 'high');
  // Only the echo modes read the carrier. A provider that waits for stdin it
  // does not need hangs on every caller that does not close the pipe, which is
  // a fault in the fake rather than in the flow being tested.
  const stdin = !mode.startsWith('echo') || process.stdin.isTTY ? '' : await new Promise((resolve) => {
    let text = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { text += chunk; });
    process.stdin.on('end', () => resolve(text));
    process.stdin.on('error', () => resolve(''));
  });
  if (mode === 'hang') {
    // Never returns on purpose. The caller's budget is what ends this.
    setInterval(() => {}, 1000);
  } else {
    const result = behaviour(mode, { model, effort, body: stdin });
    if (!result) {
      process.stderr.write(`fake-provider: unknown mode ${mode}\n`);
      process.exitCode = 64;
    } else {
      process.stdout.write(result.stdout);
      process.stderr.write(result.stderr);
      process.exitCode = result.code;
    }
  }
}
