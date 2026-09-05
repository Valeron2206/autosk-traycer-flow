/** Shared, fail-closed primitives for the runtime (not a task store). */
import { createHash, timingSafeEqual } from 'node:crypto';

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
  demand(value !== null && typeof value === 'object' && !Array.isArray(value)
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
    demand(item && typeof item === 'object' && !active.has(item), 'invalid_identity', 'Non-JSON or cyclic identity');
    active.add(item);
    let result;
    if (Array.isArray(item)) {
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
export function assertOid(value, format) {
  demand(['sha1', 'sha256'].includes(format), 'unsupported_object_format', 'Unsupported Git object format');
  demand(typeof value === 'string' && new RegExp(`^[a-f0-9]{${format === 'sha1' ? 40 : 64}}$`, 'u').test(value)
    && !/^0+$/u.test(value), 'invalid_oid', 'Expected a full nonzero Git OID');
  return value;
}
export function gitObjectOid(type, bytes, format) {
  demand(['blob', 'tree', 'commit', 'tag'].includes(type), 'invalid_object_type', 'Unknown Git object type');
  demand(['sha1', 'sha256'].includes(format) && Buffer.isBuffer(bytes), 'invalid_object', 'Invalid object input');
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
