/**
 * Tests for the extension distribution registry (issue #10).
 *
 * A distribution is named by the digest of its bytes, so "the same version"
 * cannot mean two different things on two machines. What is tested here is the
 * part that makes the name usable: who is pinned to what, what may therefore be
 * removed, and what a migration does to Epics that are already running.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  acquire,
  emptyRegistry,
  evictionPlan,
  holders,
  migrationPlan,
  registerDistribution,
  release,
  rollbackPlan,
  setCurrent,
} from "../src/host/distribution-registry.mjs";

const code = (name) => (error) => error.code === name;
const A = "a".repeat(64);
const B = "b".repeat(64);

function registry() {
  let state = emptyRegistry();
  state = registerDistribution(state, { digest: A, version: "1.0.0", members: ["index.mjs"] });
  state = registerDistribution(state, { digest: B, version: "1.1.0", members: ["index.mjs", "extra.mjs"] });
  return setCurrent(state, A);
}

test("the same bytes are one distribution, not two", () => {
  const once = registerDistribution(emptyRegistry(), { digest: A, version: "1.0.0", members: ["index.mjs"] });
  const twice = registerDistribution(once, { digest: A, version: "1.0.0", members: ["index.mjs"] });
  assert.equal(twice.effect, "already_registered");
  assert.equal(Object.keys(twice.distributions).length, 1);
  // The same bytes under another version name is a claim the registry refuses.
  assert.throws(
    () => registerDistribution(once, { digest: A, version: "9.9.9", members: ["index.mjs"] }),
    code("distribution_digest_mismatch"),
  );
  assert.throws(
    () => registerDistribution(emptyRegistry(), { digest: "not-a-digest", version: "1", members: [] }),
    code("distribution_digest_mismatch"),
  );
});

test("a hold names the Epic that is pinning the bytes", () => {
  // "Three references" tells an operator nothing they can act on.
  let state = acquire(registry(), { digest: A, epicId: "e-1" });
  state = acquire(state, { digest: A, epicId: "e-2" });
  assert.deepEqual([...holders(state, A)], ["e-1", "e-2"]);
  assert.equal(acquire(state, { digest: A, epicId: "e-1" }).effect, "already_held");
  assert.throws(() => acquire(state, { digest: "c".repeat(64), epicId: "e-3" }), code("distribution_unknown"));

  const released = release(state, { digest: A, epicId: "e-1" });
  assert.deepEqual([...holders(released, A)], ["e-2"]);
  // Releasing twice is the same state, not an error.
  assert.equal(release(released, { digest: A, epicId: "e-1" }).effect, "not_held");
});

test("the cache never evicts the current one, nor one an Epic holds", () => {
  // Evicting held bytes would leave a running Epic without the code it was
  // admitted with, and the failure would surface as something else entirely.
  const state = acquire(setCurrent(registry(), B), { digest: A, epicId: "e-1" });
  const plan = evictionPlan(state);
  assert.deepEqual([...plan.evict], []);
  const current = plan.keep.find((entry) => entry.digest === B);
  assert.deepEqual([...current.reasons], ["current"]);
  // Every reason it is kept: this one is both the version a rollback returns to
  // and the one an Epic is running against, and reporting one would make the
  // other invisible to whoever is trying to free space.
  const held = plan.keep.find((entry) => entry.digest === A);
  assert.deepEqual([...held.reasons], ["previous", "held"]);
  assert.deepEqual([...held.by], ["e-1"]);

  // Released and no longer current or previous: now it may go.
  const freed = evictionPlan(release(state, { digest: A, epicId: "e-1" }), { keepPrevious: false });
  assert.deepEqual([...freed.evict], [A]);
});

test("the version a rollback would return to is kept by default", () => {
  // Deleting it makes rolling back a re-download of bytes the project had.
  const state = setCurrent(registry(), B);
  const plan = evictionPlan(state);
  assert.ok(plan.keep.some((entry) => entry.digest === A && entry.reasons.includes("previous")));
  assert.deepEqual([...evictionPlan(state, { keepPrevious: false }).evict], [A]);
});

test("a migration leaves running Epics on the distribution they were admitted under", () => {
  // A running Epic moved to other code is an Epic whose earlier steps were
  // verified against something else.
  const plan = migrationPlan(registry(), {
    to: B,
    openEpics: [
      { epic_id: "e-1", distribution_digest: A },
      { epic_id: "e-2", distribution_digest: B },
    ],
  });
  assert.equal(plan.to, B);
  assert.equal(plan.from, A);
  assert.equal(plan.new_epics_use, B);
  assert.deepEqual(plan.epics_staying.map((entry) => entry.epic_id), ["e-1"]);
  assert.throws(() => migrationPlan(registry(), { to: "c".repeat(64), openEpics: [] }), code("distribution_unknown"));
});

test("a rollback needs the bytes and a decision, and keeps what it rolled back from", () => {
  const state = setCurrent(registry(), B);
  const plan = rollbackPlan(state, { to: A, decisionRef: "dec-7" });
  assert.equal(plan.to, A);
  assert.equal(plan.from, B);
  assert.equal(plan.retains, B);
  assert.equal(plan.decision_ref, "dec-7");
  // A rollback to something that has to be fetched again is a new install
  // wearing the old version's name.
  assert.throws(
    () => rollbackPlan(state, { to: "c".repeat(64), decisionRef: "dec-7" }),
    code("distribution_migration_blocked"),
  );
  assert.throws(() => rollbackPlan(state, { to: A }), code("distribution_migration_blocked"));
});

test("a distribution has to be registered before it can be current", () => {
  assert.throws(() => setCurrent(emptyRegistry(), A), code("distribution_unknown"));
  assert.equal(setCurrent(registry(), B).previous, A);
});
