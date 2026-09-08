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

/** What a mode prints and exits with. Pure, so the runner can be tested on it. */
export function behaviour(mode, { model = 'fake-model-1', effort = 'high' } = {}) {
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
  if (mode === 'hang') {
    // Never returns on purpose. The caller's budget is what ends this.
    setInterval(() => {}, 1000);
  } else {
    const result = behaviour(mode, { model, effort });
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
