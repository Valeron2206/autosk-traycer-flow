/**
 * Tests for the issue #21 external source snapshot.
 *
 * Two things must be impossible: a snapshot living somewhere it can be deleted
 * or moved, and a record that cannot prove the bytes it names were ever read
 * back. Most cases here are one of those two.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTRACT_PATH,
  DRIFT_OUTCOMES,
  EXAMPLE_PATH,
  FORBIDDEN_ROOTS,
  REFUSALS,
  SCHEMA_PATH,
  SUPERSEDED_EXAMPLE_PATH,
  loadFiles,
  snapshotDesignDigest,
  validateExternalSourceSnapshotDesign,
  validateSnapshot,
} from "../scripts/validate-external-source-snapshot.mjs";

const files = loadFiles();
const schema = JSON.parse(files[SCHEMA_PATH]);

const example = () => JSON.parse(files[EXAMPLE_PATH]);
const superseded = () => JSON.parse(files[SUPERSEDED_EXAMPLE_PATH]);

function mutated(mutate, base = example) {
  const value = base();
  mutate(value);
  return value;
}

function assertRejects(value, pattern) {
  const errors = validateSnapshot(value, schema);
  assert.ok(
    errors.some((message) => pattern.test(message)),
    `expected an error matching ${pattern}, got:\n${errors.join("\n") || "(none)"}`,
  );
}

test("the shipped design validates", () => {
  assert.deepEqual(validateExternalSourceSnapshotDesign(files), []);
});

test("a snapshot whose read-back disagrees is not a snapshot of anything", () => {
  assertRejects(
    mutated((value) => {
      value.read_back_sha256 = "9".repeat(64);
    }),
    /read-back digest differs/u,
  );
});

test("a snapshot that is not a copy of its source is refused", () => {
  assertRejects(
    mutated((value) => {
      value.snapshot_sha256 = "9".repeat(64);
      value.read_back_sha256 = "9".repeat(64);
    }),
    /copy of something else/u,
  );
});

test("a snapshot may not live where retention will delete it", () => {
  // The rule most likely to be broken by accident: an evidence directory is
  // exactly where a snapshot looks like it belongs.
  for (const root of FORBIDDEN_ROOTS) {
    assertRejects(
      mutated((value) => {
        value.snapshot_path = `${root}spec.pdf`;
      }),
      /snapshot_retention_conflict/u,
    );
  }
});

test("an imported source must name where it came from and who imported it", () => {
  // Reading someone else's file and calling it yours is the failure the import
  // operation exists to prevent.
  assertRejects(
    mutated((value) => {
      value.provenance.arrival = "imported";
    }),
    /must name where it came from/u,
  );
  const proper = mutated((value) => {
    value.provenance.arrival = "imported";
    value.provenance.imported_from = "/other/project/spec.pdf";
    value.provenance.import_operation_id = "import-1";
  });
  assert.deepEqual(validateSnapshot(proper, schema), []);
});

test("a source already in the project cannot claim import provenance", () => {
  assertRejects(
    mutated((value) => {
      value.provenance.imported_from = "/elsewhere/spec.pdf";
    }),
    /cannot carry import provenance/u,
  );
});

test("supersession is recorded, and does not rewrite the superseded record", () => {
  // The superseded snapshot keeps its own digests and its own anchor version:
  // history is added to, not edited.
  const old = superseded();
  assert.equal(old.lifecycle, "superseded");
  assert.equal(old.superseded_by, example().snapshot_sha256);
  assert.notEqual(old.snapshot_sha256, example().snapshot_sha256);
  assert.notEqual(old.anchor_version, example().anchor_version);
  assert.deepEqual(validateSnapshot(old, schema), []);
});

test("a superseded snapshot must name its successor, and nothing else may", () => {
  assertRejects(
    mutated((value) => {
      delete value.superseded_by;
    }, superseded),
    /must name what superseded it/u,
  );
  assertRejects(
    mutated((value) => {
      value.superseded_by = "9".repeat(64);
    }),
    /present snapshot must not name a successor/u,
  );
});

test("a snapshot cannot supersede itself", () => {
  assertRejects(
    mutated((value) => {
      value.superseded_by = value.snapshot_sha256;
    }, superseded),
    /cannot supersede itself/u,
  );
});

test("both digests are required, so a write that returned cannot stand in for bytes that are there", () => {
  for (const field of ["source_sha256", "snapshot_sha256", "read_back_sha256"]) {
    assert.ok(schema.required.includes(field), `${field} is optional`);
  }
});

test("a snapshot path that escapes the project is not even shape-valid", () => {
  for (const bad of ["/etc/passwd", "../outside.pdf", "a/../../b.pdf"]) {
    assert.ok(
      validateSnapshot(
        mutated((value) => {
          value.snapshot_path = bad;
        }),
        schema,
      ).some((message) => /schema:/u.test(message)),
      `${bad} was accepted`,
    );
  }
});

test("binary sources are ordinary here: no text kind, no OCR", () => {
  // Criterion 4 of #21. The record carries a media type and byte digests, and
  // nothing in it depends on the source being readable as text.
  const pdf = example();
  assert.equal(pdf.media_type, "application/pdf");
  assert.deepEqual(validateSnapshot(pdf, schema), []);
  const png = mutated((value) => {
    value.media_type = "image/png";
    value.locator = "uploads/screen.png";
  });
  assert.deepEqual(validateSnapshot(png, schema), []);
  const contract = files[CONTRACT_PATH];
  assert.ok(contract.includes("without text normalization"));
});

test("the refusal set and the drift table are both closed and documented", () => {
  const contract = files[CONTRACT_PATH];
  for (const refusal of REFUSALS) assert.ok(contract.includes(refusal), `${refusal} is not documented`);
  for (const outcome of DRIFT_OUTCOMES) assert.ok(contract.includes(outcome), `${outcome} is not documented`);
});

test("repair uses the recorded identity, never the latest source", () => {
  // Re-minting on repair would substitute today's bytes for the ones a verdict
  // was about — the very failure this contract exists to prevent, arriving
  // through the repair path.
  const contract = files[CONTRACT_PATH];
  assert.ok(contract.includes("never re-minted from whatever the live source says now"));
});

test("the design digest changes when any shipped file changes", () => {
  const before = snapshotDesignDigest(files);
  const after = snapshotDesignDigest({ ...files, [CONTRACT_PATH]: `${files[CONTRACT_PATH]}\n` });
  assert.notEqual(before, after);
});
