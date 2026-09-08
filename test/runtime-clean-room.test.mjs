/**
 * Tests for the clean-room runner (issue #36).
 *
 * The runner itself is exercised by running it; these cover the parts that
 * decide what the run means — what the environment may carry, what the
 * toolchain is allowed to bring in, and the coverage report, which has to say
 * what was not covered rather than implying the matrix was finished.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  COVERAGE,
  FORBIDDEN_ENV,
  MATRIX_PATH,
  ROOT,
  TOOLCHAIN,
  cleanRoomEnv,
  coverageReport,
  environmentErrors,
  resolveToolchain,
} from "../scripts/clean-room-e2e.mjs";

const matrix = JSON.parse(await readFile(path.join(ROOT, MATRIX_PATH), "utf8"));

test("the environment is a fresh HOME with no Traycer in it", () => {
  const env = cleanRoomEnv({ home: "/tmp/clean/home", sourceDir: "/tmp/clean/source" });
  assert.equal(env.HOME, "/tmp/clean/home");
  assert.deepEqual(environmentErrors(env), []);
  for (const name of FORBIDDEN_ENV) {
    assert.ok(
      environmentErrors({ ...env, [name]: "/opt/traycer" })
        .some((error) => error.reason === "clean_room_traycer_present"),
      name,
    );
  }
  // A variable that merely points into a Traycer directory counts too.
  assert.ok(
    environmentErrors({ ...env, SOME_CONFIG: "/home/x/.traycer/config" })
      .some((error) => error.reason === "clean_room_traycer_present"),
  );
});

test("the operator's PATH is not inherited; the toolchain is admitted by name", () => {
  // Inheriting it would let anything on that path answer for one of these
  // tools.
  const env = cleanRoomEnv({
    home: "/tmp/clean/home",
    sourceDir: "/tmp/clean/source",
    toolchainDirs: ["/opt/homebrew/bin"],
  });
  const entries = env.PATH.split(":");
  assert.equal(entries[0], "/tmp/clean/source/bin");
  assert.ok(entries.includes("/opt/homebrew/bin"));
  assert.ok(entries.includes("/usr/bin"));
  assert.ok(!entries.includes(process.env.HOME ?? "never"));
  // Duplicates are collapsed, so the reported path is the path.
  const duplicated = cleanRoomEnv({
    home: "/h",
    sourceDir: "/s",
    toolchainDirs: ["/usr/bin", "/usr/bin"],
  });
  assert.equal(new Set(duplicated.PATH.split(":")).size, duplicated.PATH.split(":").length);
});

test("the module cache is declared and lives outside the ephemeral HOME", () => {
  // The clean room isolates autosk state, not Go's package cache; burying the
  // cache in a directory deleted after every run would re-download everything
  // and prove nothing extra.
  const env = cleanRoomEnv({ home: "/tmp/clean/home", sourceDir: "/s", moduleCache: "/tmp/modcache" });
  assert.equal(env.GOMODCACHE, "/tmp/modcache");
  assert.ok(!env.GOMODCACHE.startsWith(env.HOME));
  assert.equal(cleanRoomEnv({ home: "/h", sourceDir: "/s" }).GOMODCACHE, undefined);
});

test("the toolchain resolves by walking the path, not by asking a shell", () => {
  // A shell would apply the operator's aliases and functions, which are not
  // what a build would execute.
  assert.deepEqual(TOOLCHAIN.slice(), ["bun", "go", "make", "git", "node"]);
  return resolveToolchain("/usr/bin:/bin").then((found) => {
    assert.equal(typeof found, "object");
    for (const dir of Object.values(found)) {
      assert.ok(dir === "/usr/bin" || dir === "/bin", dir);
    }
  });
});

test("the coverage report names what was not covered", () => {
  // A run that listed sixteen groups and exercised four would be the artefact
  // this program keeps finding.
  const report = coverageReport(matrix);
  assert.equal(report.rows.length, matrix.groups.length);
  assert.equal(report.complete, false);
  assert.ok(report.counts.not_covered > 0);
  assert.ok(report.counts.covered_by_real_fault > 0);
  for (const row of report.rows) {
    assert.ok(["covered_by_real_fault", "covered_indirectly", "not_covered"].includes(row.state), row.id);
    if (row.state === "not_covered") assert.equal(row.harness, null);
    else assert.ok(row.evidence, row.id);
  }
});

test("every fault-matrix group has a coverage entry, so none is silently absent", () => {
  for (const group of matrix.groups) {
    assert.ok(Object.hasOwn(COVERAGE, group.id), `${group.id} has no coverage entry`);
  }
  for (const id of Object.keys(COVERAGE)) {
    assert.ok(matrix.groups.some((group) => group.id === id), `${id} is not in the matrix`);
  }
});

test("only a real fault counts as covered by a real fault", () => {
  const claimed = coverageReport(matrix, {
    ...COVERAGE,
    F005: { harness: "creation", evidence: "the symlink case is described", real_fault: false },
  });
  assert.equal(claimed.rows.find((row) => row.id === "F005").state, "covered_indirectly");
  assert.equal(claimed.complete, false);
  // And a full claim is only `complete` when every row is a real fault.
  const everything = Object.fromEntries(
    matrix.groups.map((group) => [group.id, { harness: "crash", evidence: "e", real_fault: true }]),
  );
  assert.equal(coverageReport(matrix, everything).complete, true);
});
