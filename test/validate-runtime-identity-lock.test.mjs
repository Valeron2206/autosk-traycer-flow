/**
 * Tests for the runtime identity lock check.
 *
 * The failure being closed is that a task admitted under one distribution could
 * finish under another, and that nothing in this repository would notice if a
 * later patch dropped the machinery preventing it.
 *
 * Two things are checked separately on purpose. That the requirement set is met
 * by the patches on disk, and that the check can fail — because a check anchored
 * to lines that always match is a green light with no lamp behind it. Every
 * refusal the contract closes is produced by something here.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  CONTRACT_PATH,
  LOCK_PATH,
  MANIFEST_PATH,
  REFUSALS,
  REFUSED_PATH,
  SCHEMA_PATH,
  addedLines,
  contractRequirements,
  countAdded,
  loadFiles,
  lockDigest,
  patchReader,
  removedLines,
  surviving,
  validateDesign,
  validateLock,
} from "../scripts/validate-runtime-identity-lock.mjs";

const files = loadFiles();
const schema = JSON.parse(files[SCHEMA_PATH]);
const manifest = JSON.parse(files[MANIFEST_PATH]);
const lock = () => JSON.parse(files[LOCK_PATH]);
const readPatch = patchReader();

/** The shipped lock with one mutation, resealed unless the test wants it stale. */
function mutated(mutate, { reseal = true } = {}) {
  const document = lock();
  mutate(document);
  if (reseal) document.lock_digest = lockDigest(document);
  return document;
}

const codes = (errors) => [...new Set(errors.map((message) => message.split(":")[0]))].sort();

function assertRefuses(document, code, options = {}) {
  const errors = validateLock(document, schema, { manifest, readPatch, ...options });
  assert.ok(
    errors.some((message) => message.startsWith(code)),
    `expected ${code}, got:\n${errors.join("\n") || "(no findings)"}`,
  );
}

// --- the shipped set -------------------------------------------------------

test("the shipped design validates", () => {
  assert.deepEqual(validateDesign(files), []);
});

test("every requirement is met by the patches the manifest pins", () => {
  assert.deepEqual(validateLock(lock(), schema, { manifest, readPatch }), []);
});

test("the refused example is refused, by the classes a document can carry", () => {
  const errors = validateLock(JSON.parse(files[REFUSED_PATH]), schema, { manifest, readPatch });
  assert.deepEqual(codes(errors), [
    "lock_digest_stale",
    "lock_duplicate_id",
    "lock_patch_unknown",
    "lock_requirement_count",
    "lock_requirement_unmet",
  ]);
});

test("the contract closes every refusal this validator can produce", () => {
  for (const refusal of REFUSALS) {
    assert.ok(files[CONTRACT_PATH].includes(`\`${refusal}\``), `${refusal} is not closed by ${CONTRACT_PATH}`);
  }
});

test("the contract names every requirement the lock declares", () => {
  // A requirement the contract does not explain is a guarantee nobody was told
  // about, and one that could therefore be removed without anyone objecting.
  for (const requirement of lock().requirements) {
    assert.ok(files[CONTRACT_PATH].includes(requirement.id), `${requirement.id} is not named in the contract`);
  }
});

// --- the check can fail ----------------------------------------------------

test("lock_requirement_unmet: the patch stops adding the line", () => {
  assertRefuses(
    mutated((document) => {
      document.requirements[0].added_line = "export const NOTHING_ADDS_THIS = 1;";
    }),
    "lock_requirement_unmet",
  );
});

test("lock_requirement_count: the line is there and the count is not", () => {
  assertRefuses(
    mutated((document) => {
      document.requirements[0].occurrences = 2;
    }),
    "lock_requirement_count",
  );
});

test("lock_patch_unknown: a requirement names a patch the manifest does not carry", () => {
  assertRefuses(
    mutated((document) => {
      document.requirements[0].introduced_by = "patches/9999-invented.patch";
    }),
    "lock_patch_unknown",
  );
});

test("lock_patch_digest_stale: the bytes on disk are not the bytes the manifest pins", () => {
  // The manifest catches this too. It is a class of its own because a requirement
  // anchored to bytes this validator never verified would be an assertion about a
  // file it did not open, and that is the shape of a check that proves nothing.
  const tampered = (relative) => Buffer.concat([readPatch(relative), Buffer.from("\n")]);
  assertRefuses(lock(), "lock_patch_digest_stale", { readPatch: tampered });
});

test("lock_duplicate_id: two requirements answer to one name", () => {
  assertRefuses(
    mutated((document) => {
      document.requirements[1].id = document.requirements[0].id;
    }),
    "lock_duplicate_id",
  );
});

test("lock_digest_stale: a requirement changes and the digest does not", () => {
  assertRefuses(
    mutated((document) => {
      document.requirements[0].why = "something else";
    }, { reseal: false }),
    "lock_digest_stale",
  );
});

test("lock_schema: a requirement missing a field is refused before anything is read", () => {
  const document = lock();
  delete document.requirements[0].why;
  const errors = validateLock(document, schema, { manifest, readPatch });
  assert.deepEqual(codes(errors), ["lock_schema"], errors.join("\n"));
});

test("lock_not_json: a lock that does not parse is refused, not skipped", () => {
  const errors = validateDesign({ ...files, [MANIFEST_PATH]: "{" });
  assert.ok(errors.some((message) => message.startsWith("lock_not_json")), errors.join("\n"));
});

// --- the anchoring itself --------------------------------------------------

test("a file header is not an added line", () => {
  // `+++ b/path` opens every file in a unified diff. Counting it would let a
  // requirement be satisfied by a filename rather than by content.
  const lines = addedLines("+++ b/daemon/core/src/engine/runtimeIdentity.ts\n+real\n-gone\n context");
  assert.deepEqual(lines, ["real"]);
});

test("an anchor matches a whole line, not a fragment of one", () => {
  const patch = "+const EXTENSION_VERSION_MISMATCH_SUFFIXED = 1;\n+const x = 2;\n";
  assert.equal(countAdded(patch, "const EXTENSION_VERSION_MISMATCH_SUFFIXED = 1;"), 1);
  assert.equal(countAdded(patch, "const EXTENSION_VERSION_MISMATCH"), 0);
});

test("the requirements cover both halves of the lock and all three moments", () => {
  const declared = new Set(lock().requirements.map((entry) => entry.id));
  // Named individually rather than counted: a count passes while the requirement
  // that mattered is the one that left.
  for (const id of [
    "distribution_digest_compared",
    "graph_digest_compared",
    "checked_between_steps",
    "absent_shape_is_not_covered",
    "canonical_sorts_steps",
  ]) {
    assert.ok(declared.has(id), `${id} is what the lock is for and the set no longer requires it`);
  }
});

test("every requirement states what goes wrong without it", () => {
  for (const requirement of lock().requirements) {
    assert.ok(requirement.why.length > 40, `${requirement.id} has no reason anyone could defend it with`);
    assert.notEqual(requirement.requires, requirement.why, `${requirement.id} restates itself instead of saying the cost`);
  }
});

test("the digest binds the set, not each row", () => {
  // Reordering the requirements is a reshuffle of a set and must move the digest,
  // because the document is written in the order a reader meets it; what must not
  // change it is reading the same document twice.
  assert.equal(lockDigest(lock()), lockDigest(lock()));
  const reordered = lock();
  reordered.requirements = [...reordered.requirements].reverse();
  assert.notEqual(lockDigest(reordered), lock().lock_digest);
});

test("the lock digest is over the document and not over itself", () => {
  const document = lock();
  const recorded = document.lock_digest;
  document.lock_digest = createHash("sha256").update("something else").digest("hex");
  assert.equal(lockDigest(document), recorded, "changing the recorded digest must not change what it should be");
});


// --- the two the first round got wrong ------------------------------------

test("a later patch that removes the line fails the requirement it belonged to", () => {
  // The first writing of this check counted the additions of the patch that
  // introduced a line. That asks what the series once did. A patch appended after
  // it could delete the guarantee and nothing failed, which is the one thing the
  // check exists to catch.
  const removal = [
    "--- a/daemon/core/src/extensions/graph.ts",
    "+++ b/daemon/core/src/extensions/graph.ts",
    "-export function canonicalWorkflowGraph(wf: WorkflowDefinition): string {",
    '+const canonicalWorkflowGraph = () => "";',
    "",
  ].join("\n");
  const file = "patches/0032-remove-canonical.patch";
  const later = {
    ...manifest,
    patches: [...manifest.patches, { file, sha256: createHash("sha256").update(removal).digest("hex") }],
  };
  const reader = (relative) => (relative === file ? Buffer.from(removal) : readPatch(relative));
  const errors = validateLock(lock(), schema, { manifest: later, readPatch: reader });
  assert.ok(
    errors.some((message) => message.startsWith("lock_requirement_unmet") && message.includes("shape_digest_is_canonical")),
    `a later removal must fail, got:\n${errors.join("\n") || "(nothing)"}`,
  );
  // And it must say who took it, or the failure sends a reader through 31 patches.
  assert.ok(errors.some((message) => message.includes(file)), "the failure names the patch that last touched the line");
});

test("a requirement removed from the resource fails against the contract that still promises it", () => {
  // One direction was not enough. Checking only that a declared requirement is
  // named let the requirement be deleted and resealed while the contract kept
  // promising it — so the guarantee left without touching the document under full
  // panel review, which was the whole argument for reviewing this file narrowly.
  for (const requirement of lock().requirements) {
    const shortened = lock();
    shortened.requirements = shortened.requirements.filter((entry) => entry.id !== requirement.id);
    shortened.lock_digest = lockDigest(shortened);
    const errors = validateDesign({ ...files, [LOCK_PATH]: JSON.stringify(shortened) });
    assert.ok(
      errors.some((message) => message.includes(`does not require ${requirement.id}`)),
      `removing ${requirement.id} must fail, got:\n${errors.join("\n") || "(nothing)"}`,
    );
  }
});

test("the contract's promises and the resource's requirements are the same set", () => {
  const promised = contractRequirements(files[CONTRACT_PATH]);
  const declared = new Set(lock().requirements.map((entry) => entry.id));
  assert.deepEqual([...promised].sort(), [...declared].sort());
});

test("a promise is read from the requirement table, not from prose that mentions an id", () => {
  // Otherwise a paragraph naming a requirement in passing would count as promising
  // it, and the two sets would agree by accident.
  const prose = "The requirement `refusal_declared` is discussed here.\n| `only_this_one` | a row |\n";
  assert.deepEqual([...contractRequirements(prose)], ["only_this_one"]);
});

test("a line added and later removed leaves nothing behind", () => {
  const series = [
    { file: "a", text: "+the line\n" },
    { file: "b", text: "-the line\n" },
  ];
  assert.deepEqual(surviving(series, "the line"), { count: 0, lastTouched: "b" });
  assert.deepEqual(surviving([series[0]], "the line"), { count: 1, lastTouched: "a" });
});

test("a file header is not a removed line either", () => {
  // `--- a/path` opens every file in a unified diff, the mirror of `+++`.
  assert.deepEqual(removedLines("--- a/x\n-real\n+added\n context"), ["real"]);
});
