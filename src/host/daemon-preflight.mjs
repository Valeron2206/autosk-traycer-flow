/** Refuse to start on a daemon that does not have the guarantees this flow needs.
 * This decides admission from an observed capability report; it performs no I/O
 * and grants nothing. The report itself is the daemon's, derived there from its
 * live handler table.
 */
import { closedRecord, demand, immutable, compareCodePoints } from '../runtime/contracts.mjs';
import { types } from 'node:util';

/** What autosk-flow cannot run without, at the exact contract revision it was written against.
 * `task.creation-binding` v1: write-once `creation_key` + `creation_binding_hash` under the
 * cross-process project lock, exact retry returns the same task, a different binding conflicts,
 * and neither field can be edited afterwards. Without it, child fan-out would have to find a
 * partially-created child by its editable title — the duplicate/orphan hazard #11 exists to remove.
 */
export const REQUIRED_DAEMON_CAPABILITIES = immutable([
  { name: 'task.creation-binding', version: 1 },
]);

const MAX_CAPABILITIES = 64;
const name = (value, field) => demand(typeof value === 'string'
  && /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u.test(value) && value.length <= 128,
'daemon_capability_invalid', 'Invalid capability name', { field });

/** Validates the observed report and returns it pinned, or throws `FlowError`.
 * Every rejection is a refusal to start, never a downgrade: an unreadable report says
 * nothing about the daemon, and "nothing" is not evidence of the guarantee.
 */
export function requireDaemonCapabilities(report, required = REQUIRED_DAEMON_CAPABILITIES) {
  closedRecord(report, ['capabilities']);
  const list = report.capabilities;
  demand(!types.isProxy(list) && Array.isArray(list) && Object.getPrototypeOf(list) === Array.prototype
    && list.length <= MAX_CAPABILITIES && Reflect.ownKeys(list).length === list.length + 1,
  'daemon_capability_invalid', 'Invalid bounded capability list');
  const observed = new Map();
  for (let i = 0; i < list.length; i += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(list, String(i));
    demand(descriptor && descriptor.enumerable && Object.hasOwn(descriptor, 'value'),
      'daemon_capability_invalid', 'Capability accessors or holes are forbidden');
    const entry = closedRecord(list[i], ['name', 'version', 'methods'], `/capabilities/${i}`);
    name(entry.name, `/capabilities/${i}/name`);
    demand(Number.isSafeInteger(entry.version) && entry.version >= 1,
      'daemon_capability_invalid', 'Invalid capability version', { field: `/capabilities/${i}/version` });
    // A capability with no methods cannot have been derived from a handler table,
    // so it is a hand-written claim rather than a report of what exists.
    demand(!types.isProxy(entry.methods) && Array.isArray(entry.methods)
      && Object.getPrototypeOf(entry.methods) === Array.prototype
      && entry.methods.length >= 1 && entry.methods.length <= MAX_CAPABILITIES
      && Reflect.ownKeys(entry.methods).length === entry.methods.length + 1
      && entry.methods.every((method) => typeof method === 'string' && method.length > 0 && method.length <= 128),
    'daemon_capability_invalid', 'A capability must name the methods that implement it',
    { field: `/capabilities/${i}/methods` });
    demand(!observed.has(entry.name), 'daemon_capability_invalid',
      'The same capability is reported twice', { field: `/capabilities/${i}/name` });
    observed.set(entry.name, entry);
  }
  const missing = [];
  const wrongVersion = [];
  for (const want of required) {
    const have = observed.get(want.name);
    if (!have) { missing.push(want.name); continue; }
    // Exact, not a minimum: the revision is incremented precisely when a client
    // must notice, so accepting a later one accepts the change it warns about.
    if (have.version !== want.version) wrongVersion.push(`${want.name} is v${have.version}, this flow is written for v${want.version}`);
  }
  demand(missing.length === 0, 'daemon_capability_missing',
    'This daemon does not have a capability autosk-flow cannot run without',
    { missing: missing.sort(compareCodePoints) });
  demand(wrongVersion.length === 0, 'daemon_capability_version_mismatch',
    'This daemon offers a different revision of a required capability',
    { mismatched: wrongVersion.sort(compareCodePoints) });
  return immutable({ schema_version: 1, capabilities: [...observed.values()] });
}
