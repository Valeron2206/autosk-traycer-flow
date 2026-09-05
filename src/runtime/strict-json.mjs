/** Bounded JSON decoding with duplicate-key rejection before values become authority. */
import { FlowError, demand } from './contracts.mjs';

export function parseStrictJson(input, { maxBytes = 1_048_576, maxDepth = 64, maxNodes = 100_000 } = {}) {
  demand(Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= 16_777_216
    && Number.isSafeInteger(maxDepth) && maxDepth > 0 && maxDepth <= 128
    && Number.isSafeInteger(maxNodes) && maxNodes > 0 && maxNodes <= 1_000_000,
  'invalid_limit', 'Invalid JSON input limits');
  demand(typeof input === 'string' || Buffer.isBuffer(input) || input instanceof Uint8Array,
    'json_invalid', 'JSON input must be bytes or text');
  const size = typeof input === 'string' ? Buffer.byteLength(input) : input.byteLength;
  demand(size <= maxBytes, 'json_limit', 'JSON exceeds raw byte budget');
  const bytes = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  demand(!(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf), 'json_invalid', 'JSON BOM is forbidden');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new FlowError('json_invalid', 'JSON is not valid UTF-8'); }
  if (typeof input === 'string') demand(text === input, 'json_invalid', 'JSON text contains invalid Unicode');
  let offset = 0; let nodes = 0;
  const whitespace = () => { while (/[\x20\t\r\n]/u.test(text[offset] ?? 'x')) offset += 1; };
  const invalid = () => { throw new FlowError('json_invalid', 'Invalid JSON syntax', { offset }); };
  function string() {
    if (text[offset] !== '"') invalid();
    const start = offset++;
    while (offset < text.length) {
      const character = text[offset++];
      if (character === '\\') { offset += 1; continue; }
      if (character === '"') {
        try { return JSON.parse(text.slice(start, offset)); } catch { invalid(); }
      }
    }
    invalid();
  }
  function value(depth) {
    demand(depth <= maxDepth && ++nodes <= maxNodes, 'json_limit', 'JSON exceeds structural budget');
    whitespace(); const first = text[offset];
    if (first === '"') { string(); return; }
    if (first === '{' || first === '[') {
      const object = first === '{'; const close = object ? '}' : ']'; const keys = new Set();
      offset += 1; whitespace();
      if (text[offset] === close) { offset += 1; return; }
      while (offset < text.length) {
        if (object) {
          const key = string();
          demand(!keys.has(key), 'json_duplicate_key', 'Duplicate JSON object key', { offset });
          keys.add(key); whitespace(); if (text[offset++] !== ':') invalid();
        }
        value(depth + 1); whitespace();
        if (text[offset] === close) { offset += 1; return; }
        if (text[offset++] !== ',') invalid();
        whitespace();
      }
      invalid();
    }
    const match = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/u.exec(text.slice(offset));
    if (!match) invalid();
    offset += match[0].length;
  }
  value(0); whitespace(); if (offset !== text.length) invalid();
  try { return JSON.parse(text); }
  catch { throw new FlowError('json_invalid', 'Invalid JSON value'); }
}
