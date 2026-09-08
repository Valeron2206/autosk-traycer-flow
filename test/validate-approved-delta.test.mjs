/**
 * Tests for the issue #8 approved-delta validator.
 *
 * Two things are being defended. That a delta is the reviewed unit — so the
 * second independent Ticket does not fail a whole-tree comparison for the crime
 * of building on approved work. And that a delta is more than a patch, so the
 * cases where text is identical and effect is not cannot pass unnoticed.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  CONTRACT_PATH,
  EXAMPLE_PATH,
  INHERITED_GIT_ENV,
  PARK_REASONS,
  PHASES,
  ROOT,
  SCHEMA_PATH,
  approvedDeltaDesignDigest,
  deltaDigest,
  inScope,
  loadFiles,
  validateApprovedDeltaDesign,
  validateDelta,
} from "../scripts/validate-approved-delta.mjs";

const files = loadFiles();
const schema = JSON.parse(files[SCHEMA_PATH]);

function example() {
  return JSON.parse(files[EXAMPLE_PATH]);
}

function mutated(mutate, { reseal = true } = {}) {
  const value = example();
  mutate(value);
  if (reseal) value.delta_digest = deltaDigest(value);
  return value;
}

function assertRejects(value, pattern) {
  const errors = validateDelta(value, schema);
  assert.ok(
    errors.some((message) => pattern.test(message)),
    `expected an error matching ${pattern}, got:\n${errors.join("\n") || "(none)"}`,
  );
}

function entryAt(value, filePath) {
  return value.entries.find((entry) => entry.path === filePath);
}

test("the shipped design validates", () => {
  assert.deepEqual(validateApprovedDeltaDesign(files), []);
});

test("the example validates and its digest recomputes", () => {
  const value = example();
  assert.deepEqual(validateDelta(value, schema), []);
  assert.equal(value.delta_digest, deltaDigest(value));
});

test("the example exercises the cases text alone cannot express", () => {
  // A mode flip with no diff, a symlink, a gitlink, and a rename whose blob
  // never changed. If the example omitted these, the field list would be
  // decoration and the validator would be checking nothing about them.
  const value = example();
  const modeOnly = entryAt(value, "src/run.sh");
  assert.equal(modeOnly.old_blob, modeOnly.new_blob);
  assert.notEqual(modeOnly.old_mode, modeOnly.new_mode);

  const rename = entryAt(value, "src/moved.ts");
  assert.equal(rename.old_blob, rename.new_blob);
  assert.equal(rename.from_path, "src/old.ts");

  assert.equal(entryAt(value, "src/link").new_mode, "120000");
  assert.equal(entryAt(value, "vendor/dep").new_mode, "160000");
});

test("a mode-only change is a real change and keeps its own identity", () => {
  // It has no textual diff at all. A digest over text would call it nothing.
  const before = deltaDigest(example());
  const after = deltaDigest(
    mutated(
      (value) => {
        entryAt(value, "src/run.sh").new_mode = "100644";
      },
      { reseal: false },
    ),
  );
  assert.notEqual(before, after);
});

test("a rename with an unchanged blob still moves the digest", () => {
  const before = deltaDigest(example());
  const after = deltaDigest(
    mutated(
      (value) => {
        entryAt(value, "src/moved.ts").from_path = "src/elsewhere.ts";
      },
      { reseal: false },
    ),
  );
  assert.notEqual(before, after);
});

test("a modification that changes neither blob nor mode is refused", () => {
  assertRejects(
    mutated((value) => {
      const entry = entryAt(value, "src/adapter.ts");
      entry.new_blob = entry.old_blob;
    }),
    /modifies nothing — same blob and same mode/u,
  );
});

test("an entry outside the declared pathspec is refused", () => {
  assertRejects(
    mutated((value) => {
      entryAt(value, "src/newapi.ts").path = "docs/newapi.md";
    }),
    /outside the declared pathspec \(scope_violation\)/u,
  );
});

test("a rename cannot come from outside the declared pathspec", () => {
  // The source is part of what changed, so approving the destination alone
  // would approve half of an operation.
  assertRejects(
    mutated((value) => {
      entryAt(value, "src/moved.ts").from_path = "docs/old.md";
    }),
    /renamed from outside the declared pathspec/u,
  );
});

test("each status implies which sides of the entry exist", () => {
  assertRejects(
    mutated((value) => {
      delete entryAt(value, "src/adapter.ts").old_blob;
    }),
    /status M requires old_blob/u,
  );
  assertRejects(
    mutated((value) => {
      entryAt(value, "src/newapi.ts").old_blob = "1".repeat(40);
    }),
    /an added path has no old_blob/u,
  );
  assertRejects(
    mutated((value) => {
      entryAt(value, "src/legacy.ts").new_blob = "1".repeat(40);
    }),
    /a deleted path has no new_blob/u,
  );
});

test("a rename must record where it came from, and only a rename may", () => {
  assertRejects(
    mutated((value) => {
      delete entryAt(value, "src/moved.ts").from_path;
    }),
    /must record the path it came from/u,
  );
  assertRejects(
    mutated((value) => {
      entryAt(value, "src/adapter.ts").from_path = "src/somewhere.ts";
    }),
    /only a rename or copy has a source path/u,
  );
});

test("one path cannot appear twice in one delta", () => {
  assertRejects(
    mutated((value) => {
      value.entries.push({ ...entryAt(value, "src/adapter.ts") });
    }),
    /the same path appears twice in one delta/u,
  );
});

test("a result is recorded from the phase it exists in, and not before", () => {
  // A commit OID at `prepared` claims something that has not happened; a
  // committed phase with no result loses the object a crash would need to find.
  assertRejects(
    mutated((value) => {
      value.phase = "prepared";
    }),
    /records a result that does not exist yet/u,
  );
  assertRejects(
    mutated((value) => {
      delete value.result_commit_oid;
    }),
    /must record the result commit and tree it produced/u,
  );
});

test("the digest binds the base, so a delta cannot be reinterpreted elsewhere", () => {
  const before = deltaDigest(example());
  for (const field of ["base_commit_oid", "base_tree_oid", "candidate_tree_oid"]) {
    const after = deltaDigest(
      mutated(
        (value) => {
          value[field] = "9".repeat(40);
        },
        { reseal: false },
      ),
    );
    assert.notEqual(before, after, `${field} is not in the digest`);
  }
});

test("entry order is not identity, but entry content is", () => {
  const shuffled = mutated(
    (value) => {
      value.entries.reverse();
    },
    { reseal: false },
  );
  assert.equal(deltaDigest(shuffled), deltaDigest(example()));
});

test("a delta whose digest does not recompute is refused", () => {
  assertRejects(
    mutated(
      (value) => {
        value.pathspec = ["src/**"];
      },
      { reseal: false },
    ),
    /delta_digest does not recompute/u,
  );
});

test("scope matching is prefix-based and does not leak past a directory", () => {
  assert.equal(inScope("src/a.ts", ["src/**"]), true);
  assert.equal(inScope("src/deep/a.ts", ["src/**"]), true);
  assert.equal(inScope("docs/a.md", ["src/**"]), false);
  assert.equal(inScope("exact.ts", ["exact.ts"]), true);
  assert.equal(inScope("exact.ts.bak", ["exact.ts"]), false);
});

test("the contract names the inherited Git variables and refuses cherry-pick", () => {
  // "Neutralised" is a word with no list behind it unless the list is written
  // down; an inherited variable silently redirects every command that follows.
  const contract = readFileSync(path.join(ROOT, CONTRACT_PATH), "utf8");
  for (const variable of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) {
    assert.ok(contract.includes(variable), `${variable} is not named`);
  }
  assert.ok(INHERITED_GIT_ENV.includes("GIT_DIR"));
  assert.ok(contract.includes("cherry-pick"), "cherry-pick is not ruled out");
});

test("every phase and park reason is documented", () => {
  const contract = readFileSync(path.join(ROOT, CONTRACT_PATH), "utf8");
  for (const reason of PARK_REASONS) {
    assert.ok(contract.includes(reason), `${reason} is not documented`);
  }
  assert.deepEqual(schema.properties.phase.enum, [...PHASES]);
});

test("the design digest changes when any shipped file changes", () => {
  const before = approvedDeltaDesignDigest(files);
  const after = approvedDeltaDesignDigest({ ...files, [CONTRACT_PATH]: `${files[CONTRACT_PATH]}\n` });
  assert.notEqual(before, after);
});
