/** Shared, fail-closed primitives for the runtime (not a task store). */
import { createHash, timingSafeEqual } from 'node:crypto';
import { types } from 'node:util';

export class FlowError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'FlowError';
    this.code = code;
    this.details = details;
  }
  toJSON() { return { code: this.code, message: this.message, details: this.details }; }
}

export function demand(condition, code, message, details = {}) {
  if (!condition) throw new FlowError(code, message, details);
}

export function closedRecord(value, keys, pointer = '') {
  demand(value !== null && typeof value === 'object' && !types.isProxy(value) && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value)),
  'invalid_record', 'Expected a plain record', { pointer });
  const actual = Reflect.ownKeys(value);
  demand(actual.length === keys.length && actual.every((key) => typeof key === 'string' && keys.includes(key)),
    'invalid_record', 'Record fields must match the closed contract', { pointer });
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    demand(descriptor.enumerable && Object.hasOwn(descriptor, 'value'), 'invalid_record',
      'Accessors and hidden fields are not allowed', { pointer });
  }
  return value;
}

export function compareCodePoints(a, b) {
  const left = Array.from(a, (x) => x.codePointAt(0));
  const right = Array.from(b, (x) => x.codePointAt(0));
  for (let i = 0; i < Math.min(left.length, right.length); i += 1) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return left.length - right.length;
}

/** A separate runtime identity domain; never substitutes the Tickets canonicalizer. */
export function canonicalBytes(value) {
  const active = new WeakSet();
  let count = 0;
  function serialize(item, depth) {
    demand(depth <= 64 && ++count <= 1_000_000, 'identity_limit', 'Identity exceeds structural limits');
    if (item === null || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'number') {
      demand(Number.isSafeInteger(item) && !Object.is(item, -0), 'invalid_identity', 'Only safe integers are permitted');
      return String(item);
    }
    if (typeof item === 'string') {
      demand(item === item.normalize('NFC') && !/[\uD800-\uDFFF]/u.test(item)
        && !item.includes('\0'), 'invalid_identity', 'Identity strings must be NFC Unicode without NUL');
      return JSON.stringify(item);
    }
    demand(item && typeof item === 'object' && !types.isProxy(item) && !active.has(item), 'invalid_identity', 'Non-JSON or cyclic identity');
    active.add(item);
    let result;
    if (Array.isArray(item)) {
      demand(Object.getPrototypeOf(item) === Array.prototype, 'invalid_identity', 'Expected a standard array');
      demand(Reflect.ownKeys(item).length === item.length + 1, 'invalid_identity', 'Sparse arrays or array properties are forbidden');
      for (let i = 0; i < item.length; i += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(i));
        demand(descriptor && descriptor.enumerable && Object.hasOwn(descriptor, 'value'),
          'invalid_identity', 'Array accessors and holes are forbidden');
      }
      result = `[${item.map((child) => serialize(child, depth + 1)).join(',')}]`;
    } else {
      const keys = Object.keys(item).sort(compareCodePoints);
      closedRecord(item, keys);
      result = `{${keys.map((key) => `${serialize(key, depth + 1)}:${serialize(item[key], depth + 1)}`).join(',')}}`;
    }
    active.delete(item);
    return result;
  }
  const bytes = Buffer.from(`${serialize(value, 0)}\n`, 'utf8');
  demand(bytes.length <= 16_777_216, 'identity_limit', 'Identity exceeds byte limit');
  return bytes;
}

export function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
export function digest(domain, value) {
  demand(typeof domain === 'string' && /^[a-z][a-z0-9/._-]+\/v[1-9][0-9]*$/u.test(domain),
    'invalid_domain', 'Digest domain must be explicit and versioned');
  return createHash('sha256').update(`${domain}\0`).update(canonicalBytes(value)).digest('hex');
}
export function assertDigest(value, pointer = '') {
  demand(typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value), 'invalid_digest', 'Expected SHA-256', { pointer });
  return value;
}
export function equalDigest(a, b) {
  assertDigest(a); assertDigest(b);
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}
/**
 * Git's object formats and the width of a full OID in each, in lowercase hex.
 * A repository has one format, so the OIDs one record or one operation names
 * have one width: the rule every reader and every record of an OID follows
 * (ADR-098).
 */
export const OBJECT_FORMATS = Object.freeze({ sha1: 40, sha256: 64 });
/**
 * The object format a full OID is written in, read from its width: `sha1` or
 * `sha256`, and null for anything that is not a full lowercase-hex OID of
 * either. Whether Git's null OID may stand somewhere is the caller's rule.
 */
export function oidFormat(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]+$/u.test(value)) return null;
  return Object.keys(OBJECT_FORMATS).find((format) => OBJECT_FORMATS[format] === value.length) ?? null;
}
/**
 * The one object format every OID given is written in; null when none is
 * given, one is not a full OID, or they name two — objects no one repository
 * holds together (ADR-098).
 */
export function oneObjectFormat(values) {
  const formats = new Set(values.map(oidFormat));
  return formats.size === 1 && !formats.has(null) ? [...formats][0] : null;
}
export function assertOid(value, format) {
  demand(Object.keys(OBJECT_FORMATS).includes(format), 'unsupported_object_format', 'Unsupported Git object format');
  demand(oidFormat(value) === format && !/^0+$/u.test(value), 'invalid_oid', 'Expected a full nonzero Git OID');
  return value;
}
export function gitObjectOid(type, bytes, format) {
  demand(['blob', 'tree', 'commit', 'tag'].includes(type), 'invalid_object_type', 'Unknown Git object type');
  demand(Object.keys(OBJECT_FORMATS).includes(format) && Buffer.isBuffer(bytes), 'invalid_object', 'Invalid object input');
  return createHash(format).update(`${type} ${bytes.length}\0`).update(bytes).digest('hex');
}
export function assertPath(value) {
  demand(typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 4096
    && value === value.normalize('NFC') && !/[\u0000-\u001f\u007f\\]/u.test(value)
    && !/[\uD800-\uDFFF]/u.test(value) && !/^[A-Za-z]:/u.test(value)
    && value.split('/').length <= 128 && value.split('/').every((part) => part && !['.', '..', '.git'].includes(part.toLowerCase())),
  'unsafe_path', 'Expected a safe repository-relative path');
  return value;
}
export function assertTicketId(value) {
  demand(typeof value === 'string' && /^T[0-9]{2,8}$/u.test(value), 'invalid_ticket_id', 'Invalid stable Ticket ID');
  return value;
}
export function sameIdentity(left, right) { return canonicalBytes(left).equals(canonicalBytes(right)); }
export function immutable(value) {
  canonicalBytes(value);
  const copied = structuredClone(value);
  function freeze(item) {
    if (item && typeof item === 'object') { Object.values(item).forEach(freeze); Object.freeze(item); }
    return item;
  }
  return freeze(copied);
}

/**
 * Text cut at `max` code points, never inside a surrogate pair. A cut by UTF-16 unit can leave half of an astral character,
 * which is not text, and this is what error details carry when a command's own words are long.
 */
export function boundedText(value, max = 200) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  const points = Array.from(text);
  return points.length <= max ? text : points.slice(0, max).join('');
}

/**
 * A deep copy of plain data, frozen, that keeps it as it is. `immutable` is for identity and refuses what an identity may not
 * hold — text that is not NFC, a lone surrogate, an undefined field — and a path, a commit message or an author's name is data,
 * not identity: it is reported and recovered as written, and a refusal on the way back would leave a re-entry unable to
 * recover what the helper already committed.
 */
export function frozenCopy(value) {
  function copy(item) {
    if (Array.isArray(item)) return Object.freeze(item.map(copy));
    if (item !== null && typeof item === 'object') {
      return Object.freeze(Object.fromEntries(Object.entries(item).map(([key, held]) => [key, copy(held)])));
    }
    return item;
  }
  return copy(value);
}

/**
 * The details of a stop as a step body may hand them on: JSON-safe, total and bounded. An undefined field is dropped, text is kept
 * as it is and cut at `max` code points, a number that is not finite is null, and anything that is not plain data is its string.
 */
export function safeDetails(value, { max = 200, depth = 6 } = {}) {
  function copy(item, level) {
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'string') return boundedText(item, max);
    if (typeof item === 'number') return Number.isFinite(item) ? item : null;
    if (level >= depth) return boundedText(String(item), max);
    if (Array.isArray(item)) return Object.freeze(item.map((held) => (held === undefined ? null : copy(held, level + 1))));
    if (typeof item === 'object') {
      const entries = Object.entries(item).filter(([, held]) => held !== undefined && typeof held !== 'function' && typeof held !== 'symbol');
      return Object.freeze(Object.fromEntries(entries.map(([key, held]) => [boundedText(key, 64), copy(held, level + 1)])));
    }
    return boundedText(String(item), max);
  }
  return copy(value, 0);
}
