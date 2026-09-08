/**
 * Tests for the issue #12 instruction-lock validator.
 *
 * Each case mutates the worked example in exactly one way and asserts the check
 * that is supposed to catch it fires. A validator whose checks are never
 * observed failing is indistinguishable from one that returns an empty array.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  CONTRACT_PATH,
  EXAMPLE_PATH,
  EXCLUSION_REASONS,
  PARK_REASONS,
  PRECEDENCE,
  ROOT,
  SCHEMA_PATH,
  combinedDigest,
  instructionLockDesignDigest,
  loadFiles,
  validateInstructionLockDesign,
  validateLock,
} from "../scripts/validate-project-instructions-lock.mjs";

const files = loadFiles();
const schema = JSON.parse(files[SCHEMA_PATH]);

function example() {
  return JSON.parse(files[EXAMPLE_PATH]);
}

/** Applies `mutate`, re-seals the digest unless the case is about the digest. */
function mutated(mutate, { reseal = true } = {}) {
  const lock = example();
  mutate(lock);
  if (reseal) lock.combined_digest = combinedDigest(lock);
  return lock;
}

function assertRejects(lock, pattern) {
  const errors = validateLock(lock, schema);
  assert.ok(
    errors.some((message) => pattern.test(message)),
    `expected an error matching ${pattern}, got:\n${errors.join("\n") || "(none)"}`,
  );
}

test("the shipped design validates", () => {
  assert.deepEqual(validateInstructionLockDesign(files), []);
});

test("the example lock validates and its digest recomputes", () => {
  const lock = example();
  assert.deepEqual(validateLock(lock, schema), []);
  assert.equal(lock.combined_digest, combinedDigest(lock));
});

test("an unknown root field is refused: the schema is closed", () => {
  assertRejects(
    mutated((lock) => {
      lock.extra_field = "surprise";
    }),
    /schema:/u,
  );
});

test("a file whose name is not in supported_filenames cannot be admitted", () => {
  assertRejects(
    mutated((lock) => {
      lock.admitted[0].path = ".cursorrules";
      lock.admitted[0].governed_directory = "";
    }),
    /not in supported_filenames/u,
  );
});

test("a traversing path is refused rather than normalised away", () => {
  assertRejects(
    mutated((lock) => {
      lock.admitted[1].path = "daemon/../../etc/AGENTS.md";
      lock.admitted[1].governed_directory = "daemon/../../etc";
    }),
    /leaves the tree|schema:/u,
  );
});

test("governed_directory must be the file's own parent", () => {
  assertRejects(
    mutated((lock) => {
      lock.admitted[2].governed_directory = "daemon";
    }),
    /governed_directory must be the file's own parent/u,
  );
});

test("two files governing one directory park instead of choosing an order", () => {
  assertRejects(
    mutated((lock) => {
      lock.admitted[2].path = "daemon/CLAUDE.md";
      lock.admitted[2].governed_directory = "daemon";
    }),
    /same_depth_conflict/u,
  );
});

test("a shallower scope may not follow a deeper one", () => {
  assertRejects(
    mutated((lock) => {
      const [root, mid, deep] = lock.admitted;
      lock.admitted = [
        { ...deep, ordinal: 1 },
        { ...mid, ordinal: 2 },
        { ...root, ordinal: 3 },
      ];
    }),
    /shallower scope must not follow a deeper one/u,
  );
});

test("ordinals must be contiguous from one", () => {
  assertRejects(
    mutated((lock) => {
      lock.admitted[1].ordinal = 5;
      lock.admitted[2].ordinal = 6;
    }),
    /ordinals must start at 1 and be contiguous/u,
  );
});

test("the precedence list is the contract, not a preference", () => {
  assertRejects(
    mutated((lock) => {
      lock.precedence = [
        "pinned_project_instructions",
        "user_corrections",
        "approved_epic_artifacts",
        "governance_protocol",
        "role_stage_contract",
      ];
    }),
    /precedence must be exactly/u,
  );
});

test("a path cannot be admitted and excluded at once", () => {
  assertRejects(
    mutated((lock) => {
      lock.excluded.push({ path: lock.admitted[0].path, reason: "unsupported_filename" });
    }),
    /also admitted; a path is one or the other/u,
  );
});

test("a refused non-blob must record the mode it refused", () => {
  assertRejects(
    mutated((lock) => {
      delete lock.excluded[1].mode;
    }),
    /must record the mode it refused/u,
  );
});

test("an exclusion reason outside the closed set is refused", () => {
  assertRejects(
    mutated((lock) => {
      lock.excluded[0].reason = "looked_wrong";
    }),
    /schema:|is not a recordable exclusion reason/u,
  );
});

test("a lock whose digest does not recompute is refused", () => {
  assertRejects(
    mutated(
      (lock) => {
        lock.admitted[0].sha256 = "f".repeat(64);
      },
      { reseal: false },
    ),
    /combined_digest does not recompute/u,
  );
});

test("the digest covers the rule that produced the admitted set, not only the set", () => {
  // A lock that keeps its digest while `supported_filenames` changes would claim
  // the same identity for a different discovery outcome.
  const before = combinedDigest(example());
  const after = combinedDigest(
    mutated(
      (lock) => {
        lock.supported_filenames = [...lock.supported_filenames, "GEMINI.md"];
      },
      { reseal: false },
    ),
  );
  assert.notEqual(before, after);
});

test("an unrelated field does not move the digest", () => {
  const before = combinedDigest(example());
  const after = combinedDigest(
    mutated(
      (lock) => {
        lock.excluded[0].detail = "reworded, same decision";
      },
      { reseal: false },
    ),
  );
  assert.equal(before, after);
});

test("limits are enforced against the recorded sizes", () => {
  assertRejects(
    mutated((lock) => {
      lock.limits.max_total_instruction_bytes = 100;
    }),
    /exceed limits.max_total_instruction_bytes/u,
  );
  assertRejects(
    mutated((lock) => {
      lock.limits.max_file_bytes = 100;
    }),
    /size_bytes exceeds limits.max_file_bytes/u,
  );
});

test("project identity must be a digest, not a path", () => {
  assertRejects(
    mutated((lock) => {
      lock.project.project_identity = "/srv/projects/example";
    }),
    /schema:|must be a sha256/u,
  );
});

test("every park reason is documented in the contract", () => {
  const contract = readFileSync(path.join(ROOT, CONTRACT_PATH), "utf8");
  for (const reason of PARK_REASONS) {
    assert.ok(contract.includes(reason), `${reason} is not documented`);
  }
  for (const reason of EXCLUSION_REASONS) {
    assert.ok(PARK_REASONS.includes(reason), `${reason} is recordable but not a park reason`);
  }
});

test("the contract names the schema it is validated against", () => {
  const contract = readFileSync(path.join(ROOT, CONTRACT_PATH), "utf8");
  assert.ok(contract.includes(SCHEMA_PATH));
  for (const rank of PRECEDENCE) {
    assert.ok(
      contract.includes(rank.replaceAll("_", " ")) || contract.includes(rank),
      `precedence rank ${rank} is not in the contract`,
    );
  }
});

test("an executable instruction file is admitted, with its mode recorded", () => {
  // The contract admits any regular blob. The executable bit changes nothing
  // about the bytes, so rejecting on it would be a rule the prose does not have.
  const lock = mutated((entry) => {
    entry.admitted[1].mode = "100755";
  });
  assert.deepEqual(validateLock(lock, schema), []);
  // ...and it is part of identity, so it cannot be flipped silently.
  assert.notEqual(lock.combined_digest, JSON.parse(files[EXAMPLE_PATH]).combined_digest);
});

test("a mode that is not a regular blob cannot be admitted", () => {
  assertRejects(
    mutated((lock) => {
      lock.admitted[1].mode = "120000";
    }),
    /schema:/u,
  );
});

test("outside_root is recordable, so the closed set has no dead branch", () => {
  // A conforming walk of one tree cannot emit it. It exists so a validator can
  // name what it rejects in a lock this project did not produce.
  const lock = mutated((entry) => {
    entry.excluded.push({ path: "../sibling/AGENTS.md", reason: "outside_root" });
  });
  assert.deepEqual(validateLock(lock, schema), []);
});

test("the design digest changes when any of the three files changes", () => {
  const before = instructionLockDesignDigest(files);
  const after = instructionLockDesignDigest({ ...files, [CONTRACT_PATH]: `${files[CONTRACT_PATH]}\n` });
  assert.notEqual(before, after);
});
