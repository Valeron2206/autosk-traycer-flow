/**
 * Tests for the issue #36 clean-room fault-matrix validator.
 *
 * A fault group that reports success has proved nothing on its own. Each case
 * here removes one of the four proofs, or one of the coverage guarantees, and
 * checks the matrix stops being acceptable — because a gate that accepts a
 * matrix proving nothing is a gate in name only.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  BOUNDARIES,
  CONTRACT_PATH,
  GATE_FAILING_OUTCOMES,
  MATRIX_PATH,
  PARK_REASONS,
  PROOF_KINDS,
  ROOT,
  SCHEMA_PATH,
  cleanRoomDesignDigest,
  gatePasses,
  loadFiles,
  validateCleanRoomDesign,
  validateMatrix,
} from "../scripts/validate-clean-room-e2e.mjs";
import { COVERAGE } from "../scripts/lib/clean-room-coverage.mjs";

const files = loadFiles();
const schema = JSON.parse(files[SCHEMA_PATH]);

function matrix() {
  return JSON.parse(files[MATRIX_PATH]);
}

function mutated(mutate) {
  const value = matrix();
  mutate(value);
  return value;
}

function assertRejects(value, pattern) {
  const errors = validateMatrix(value, schema);
  assert.ok(
    errors.some((message) => pattern.test(message)),
    `expected an error matching ${pattern}, got:\n${errors.join("\n") || "(none)"}`,
  );
}

test("the shipped design validates", () => {
  assert.deepEqual(validateCleanRoomDesign(files), []);
});

test("the shipped matrix validates", () => {
  assert.deepEqual(validateMatrix(matrix(), schema), []);
});

test("every fault group carries all four proofs", () => {
  // Each rules out a different way of proving nothing: never applied, not
  // observable, not specific, or the room left dirty for the next fault.
  for (const group of matrix().groups) {
    const kinds = group.proofs.map((proof) => proof.kind).sort();
    assert.deepEqual(kinds, [...PROOF_KINDS].sort(), `${group.id} does not carry all four`);
  }
});

test("a group missing any single proof is refused", () => {
  for (const kind of PROOF_KINDS) {
    assertRejects(
      mutated((value) => {
        const group = value.groups[0];
        const remaining = group.proofs.filter((proof) => proof.kind !== kind);
        // Duplicate one of the survivors to keep the count at four, so the
        // schema does not reject the shape first and leave the missing-proof
        // check unobserved.
        group.proofs = [...remaining, { ...remaining[0], note: "duplicated to keep the count" }];
      }),
      new RegExp(`has no ${kind}$`, "u"),
    );
  }
});

test("a group with the same proof twice is refused", () => {
  // The other half of the same rule: four entries that are not four kinds.
  assertRejects(
    mutated((value) => {
      const group = value.groups[0];
      group.proofs = [group.proofs[0], { ...group.proofs[0] }, group.proofs[1], group.proofs[2]];
    }),
    /has 2 application_proof entries/u,
  );
});

test("a proof with no locator proves nothing", () => {
  assertRejects(
    mutated((value) => {
      value.groups[0].proofs[0].locator = "   ";
    }),
    /has no locator, so nothing can be checked against it/u,
  );
});

test("every boundary the flow crosses has a fault group", () => {
  // A boundary with no group is a boundary nobody attacked.
  const covered = new Set(matrix().groups.map((group) => group.boundary));
  for (const boundary of BOUNDARIES) {
    assert.ok(covered.has(boundary), `${boundary} has no fault group`);
  }
  assertRejects(
    mutated((value) => {
      value.groups = value.groups.filter((group) => group.boundary !== "final_cas");
    }),
    /final_cas: no fault group crosses this boundary/u,
  );
});

test("every outcome the gate must refuse is demonstrated by a group", () => {
  // Otherwise the refusal is a rule with nothing behind it.
  const outcomes = new Set(matrix().groups.map((group) => group.expected_gate_outcome));
  for (const outcome of GATE_FAILING_OUTCOMES) {
    assert.ok(outcomes.has(outcome), `${outcome} is not demonstrated`);
  }
  assertRejects(
    mutated((value) => {
      for (const group of value.groups) {
        if (group.expected_gate_outcome === "timeout") group.expected_gate_outcome = "pass";
      }
    }),
    /timeout: the gate must refuse it, and no group demonstrates it/u,
  );
});

test("a passing run is demonstrated too", () => {
  assertRejects(
    mutated((value) => {
      for (const group of value.groups) {
        if (group.expected_gate_outcome === "pass") group.expected_gate_outcome = "timeout";
      }
    }),
    /no group is expected to pass/u,
  );
});

test("the gate refuses exactly the five named outcomes", () => {
  for (const outcome of GATE_FAILING_OUTCOMES) {
    assert.equal(gatePasses(outcome), false, `${outcome} should fail the gate`);
  }
  assert.equal(gatePasses("pass"), true);
  assertRejects(
    mutated((value) => {
      value.gate_failing_outcomes = value.gate_failing_outcomes.filter((entry) => entry !== "indeterminate");
    }),
    /gate_failing_outcomes omits indeterminate/u,
  );
});

test("a duplicate group id is refused", () => {
  assertRejects(
    mutated((value) => {
      value.groups[1].id = value.groups[0].id;
    }),
    /id declared twice/u,
  );
});

test("the matrix covers the restore failure the issue names by hand", () => {
  // "The same branch name with a different ref, tree, blob, mode or task
  // metadata is not a restore" — the proof most easily faked.
  const restore = matrix().groups.find((group) => group.expected_gate_outcome === "restore_failed");
  assert.ok(restore, "no group demonstrates a failed restore");
  assert.match(restore.description, /wrong tree|wrong ref|branch name/u);
});

test("the matrix covers a no-op injector reporting success", () => {
  const noop = matrix().groups.find((group) => group.expected_gate_outcome === "mutation_not_applied");
  assert.ok(noop, "no group demonstrates a mutation that was not applied");
  assert.match(noop.fault, /no-op/u);
});

test("the schema fixes the proof count, so five proofs are not shape-valid", () => {
  const proofs = schema.properties.groups.items.properties.proofs;
  assert.equal(proofs.minItems, 4);
  assert.equal(proofs.maxItems, 4);
});

test("the contract states what the room must not contain", () => {
  // The room is defined by absence as much as by what is installed.
  const contract = readFileSync(path.join(ROOT, CONTRACT_PATH), "utf8");
  for (const absence of [".traycer", "no network", "temporary HOME"]) {
    assert.ok(contract.includes(absence), `the contract does not state "${absence}"`);
  }
});

test("every park reason is documented in the contract", () => {
  const contract = readFileSync(path.join(ROOT, CONTRACT_PATH), "utf8");
  for (const reason of PARK_REASONS) {
    assert.ok(contract.includes(reason), `${reason} is not documented`);
  }
});

test("the design digest changes when any shipped file changes", () => {
  const before = cleanRoomDesignDigest(files);
  const after = cleanRoomDesignDigest({ ...files, [CONTRACT_PATH]: `${files[CONTRACT_PATH]}\n` });
  assert.notEqual(before, after);
});

// Debt 12e (R8-7, R8-12): whether a group's run is the fault the group designs
// is a field of the group, so the coverage rule can read it. F003 says in its own
// note that the run writes no transcript or meta, and so does every written
// observation but F011's, whose script really prints success and exits 0. (F002
// said the same of the daemon restart until debt 13f: the creation harness
// performs it.)

const DEPARTS = Object.freeze(["F003", "F006", "F007", "F008", "F012", "F015", "F016", "F017", "F018", "F019", "F020"]);

test("every group says whether its run is its designed fault, and the eleven whose notes admit a departure say no", () => {
  const byId = Object.fromEntries(matrix().groups.map((entry) => [entry.id, entry.injection_matches_design]));
  for (const [id, matches] of Object.entries(byId)) assert.equal(matches, !DEPARTS.includes(id), id);
  for (const entry of matrix().groups) {
    // What the design says and the run does not, where the run departs; nothing where it does not.
    assert.equal(typeof entry.design_departure, entry.injection_matches_design ? "undefined" : "string", entry.id);
  }
});

test("a group that does not say whether its run is its designed fault is refused", () => {
  assertRejects(mutated((value) => { delete group(value, "F001").injection_matches_design; }), /injection_matches_design/u);
  assertRejects(mutated((value) => { group(value, "F001").injection_matches_design = "yes"; }), /injection_matches_design/u);
});

test("a run that departs from its design names the departure, and a run that does not names none", () => {
  assertRejects(
    mutated((value) => { delete group(value, "F003").design_departure; }),
    /F003.*departs from its designed fault and does not say how/u,
  );
  assertRejects(
    mutated((value) => { group(value, "F001").design_departure = "the run kills at the reservation only"; }),
    /F001.*design_departure.*matches its design/u,
  );
  assertRejects(mutated((value) => { group(value, "F003").design_departure = ""; }), /design_departure/u);
});

test("a note that admits the run is not the designed fault, beside a flag that says it is, is refused", () => {
  // A tripwire, not a parser: the flag is the field the rule reads, and a note
  // that says the opposite is a matrix that contradicts itself.
  for (const admission of [
    "the run kills the writer, although the fault field says it kills the daemon",
    "no process is killed: the harness writes the record",
    "no recovery runs: the harness moves the ref",
    "the harness's own git stands in for the helper",
  ]) {
    assertRejects(
      mutated((value) => { group(value, "F001").injection_note = admission; }),
      /F001.*injection_note.*admits the run is not the designed fault/u,
    );
  }
  // The shipped notes of the groups that depart say the same, beside a flag that says no.
  assert.deepEqual(validateMatrix(matrix(), schema), []);
});

test("a group that cannot be covered by a real fault on the product path names who converts it", () => {
  // F003 departs, F009 is a host function, F017 is a written observation: none
  // is counted, and each says what would count.
  for (const id of ["F003", "F009", "F017"]) {
    assertRejects(
      mutated((value) => { delete group(value, id).product_path_owner; }),
      new RegExp(`${id}.*product_path_owner`, "u"),
    );
    assertRejects(
      mutated((value) => { group(value, id).product_path_owner = "the harness"; }),
      new RegExp(`${id}.*product_path_owner.*#36`, "u"),
    );
  }
  // F001, F002 and F004 are the designed fault on the product path: nothing to convert
  // (F002 since debt 13f, when the creation harness's run was credited to it).
  for (const id of ["F001", "F002", "F004"]) {
    assertRejects(
      mutated((value) => { group(value, id).product_path_owner = "#36 converts it"; }),
      new RegExp(`${id}.*product_path_owner.*already the designed fault`, "u"),
    );
  }
});

test("the owners the matrix names are the records that own each guard's driver or helper", () => {
  const owners = Object.fromEntries(matrix().groups.filter((entry) => entry.product_path_owner).map((entry) => [entry.id, entry.product_path_owner]));
  assert.deepEqual(Object.keys(owners), matrix().groups.map((entry) => entry.id).filter((id) => !["F001", "F002", "F004"].includes(id)));
  for (const [id, owner] of Object.entries(owners)) assert.match(owner, /^#36 /u, id);
  // Review of 12e (L4): each group's owner is the record the group's guard belongs
  // to (the module that calls it: `delta-driver` for `refMovementErrors`, through
  // `integrationProof`), and for the groups the built daemon's own writes answer,
  // nothing else has to exist first. A pin per group, so a re-attribution is a decision.
  const named = (owner) => [...new Set(owner.slice(4).match(/#\d+/gu) ?? [])].sort();
  const expected = {
    F003: [], F005: [],
    F006: ["#18", "#9"], F007: ["#18", "#8", "#9"], F008: ["#18", "#8"],
    F009: ["#18", "#8"], F010: ["#18", "#8"], F011: ["#18", "#26"],
    F012: ["#18", "#24"], F013: ["#18", "#24"], F014: ["#18", "#26"],
    F015: ["#18", "#9"], F016: ["#18", "#9"],
    // CodeRabbit on #278: the helper's groups reach the product path through #18's
  // entry point too (contract §7), as every driver-owned group here says.
  F017: ["#13", "#18", "#5"], F018: ["#13", "#18", "#5"], F019: ["#13", "#18", "#5"], F020: ["#13", "#18", "#5"],
  };
  for (const [id, records] of Object.entries(expected)) assert.deepEqual(named(owners[id]), records, id);
  for (const id of ["F003", "F005"]) assert.match(owners[id], /the run builds the daemon, so no other record has to land first/u, id);
  // F005's fault is written by the built daemon's session store (`sessionStore.create` →
  // `write_session_transcript`, `write_session_meta` through `autosk-store-lock`), not by #21's driver.
  assert.match(owners.F005, /built daemon's session write/u);
  assert.doesNotMatch(owners.F005, /#21/u);
  assert.match(owners.F008, /`integrationProof` calls `refMovementErrors`/u);
});

test("F003's designed outcome is the state its kill point leaves, and its conversion names that kill point (CodeRabbit on #278)", () => {
  // The built daemon's `sessionStore.create` writes the transcript header, then the
  // session meta, through `autosk-store-lock` (`daemon/core/src/store/sessionStore.ts:241-242`
  // in the prepared source); the only other meta write, `patchMeta`, rewrites a
  // session that exists. So a kill between the two leaves the header and loses the
  // meta, and "meta written, header lost" has no path — the description says the former.
  const f003 = group(matrix(), "F003");
  assert.match(f003.fault, /between the transcript header and the meta write/u);
  assert.match(f003.description, /^transcript header written, session meta lost$/u);
  assert.doesNotMatch(f003.description, /meta written/u);
  // The conversion the owner names is that kill point, in that order.
  assert.match(f003.product_path_owner, /between the built daemon's session transcript-header write and its meta write/u);
  assert.match(f003.product_path_owner, /`sessionStore\.create` writes the header, then the meta/u);
});

test("the contract says who is owed a conversion, that it is a decision, and when a run is the designed fault", () => {
  const contract = files[CONTRACT_PATH];
  // Review of 12e (L3): 19 groups do not count and 18 have owners — the rule is
  // "each group that is not the designed fault on the product path".
  assert.match(contract, /each group that is not the designed fault on the product path names in `product_path_owner`/u);
  assert.doesNotMatch(contract, /each group that does not count names in `product_path_owner`/u);
  assert.match(contract, /F001 and F002 are the designed fault on the product path and count once #36's harness pairs a control/u);
  // Debt 13f (R9-11): F002's run is the creation harness's, and what it lacks for the gate is named.
  assert.match(contract, /F002's designed fault is run by the creation harness \(`scripts\/verify-autosk-creation\.mjs`\)/u);
  assert.match(contract, /pairs no control and emits none of the four proofs/u);
  // Nits: a substitute's silent control says nothing, and a failed one is `control_failed` first.
  assert.doesNotMatch(contract, /whatever the control did/u);
  assert.match(contract, /a control that did not stay silent is `control_failed` first/u);
  // Nits: `real_path` stays the built daemon; a host driver's group becomes it by a decision (ADR-106).
  assert.match(contract, /Such a conversion is a decision and not a side effect: `real_path` stays the built daemon answering on its own path/u);
  // Nits: the flag's standard.
  assert.match(contract, /A run is the designed fault when the operation or window the design names actually happens/u);
});

// Debt 13f (R9-11): F002's designed fault — kill the daemon, restart, repeat the same
// creation key — was given to the crash harness, which kills the native store writer and
// never restarts the daemon, while the creation harness's own run does it. A group the
// coverage rule credits to a daemon harness names that harness in its own note, so the
// record and the rule cannot give one fault to two harnesses.

test("a group the coverage rule credits to a daemon harness names that harness in its note (debt 13f)", () => {
  assert.deepEqual(
    Object.entries(COVERAGE).filter(([, entry]) => entry.harness).map(([id, entry]) => [id, entry.harness]),
    [["F001", "crash"], ["F002", "creation"], ["F003", "crash"], ["F004", "identity"]],
  );
  for (const [id, entry] of Object.entries(COVERAGE)) {
    if (!entry.harness) continue;
    assert.ok(group(matrix(), id).injection_note.includes(`the ${entry.harness} harness`), `${id}: ${group(matrix(), id).injection_note}`);
  }
  assert.deepEqual(validateMatrix(matrix(), schema), []);
});

test("F002's note gives its fault to the creation harness, and a note that gives it to the crash harness is refused (debt 13f)", () => {
  const f002 = group(matrix(), "F002");
  assert.match(f002.injection_note, /the creation harness \(`scripts\/verify-autosk-creation\.mjs`\) kills the built daemon with SIGKILL, starts it again and repeats the same creation key/u);
  assert.match(f002.injection_note, /existing_same_binding/u);
  assert.equal(f002.injection_matches_design, true);
  assert.equal(f002.design_departure, undefined);
  assert.equal(f002.product_path_owner, undefined);
  // The old attribution: the crash harness kills the store writer and never restarts the daemon.
  assertRejects(
    mutated((value) => {
      group(value, "F002").injection_note = "the crash harness kills the native store writer the daemon spawns with SIGKILL at the task-record write and repeats the creation through the running daemon";
    }),
    /F002.*injection_note.*does not name the creation harness/u,
  );
  // The other daemon groups are held to their own harness the same way.
  assertRejects(
    mutated((value) => { group(value, "F004").injection_note = "the creation harness swaps the installed distribution on disk"; }),
    /F004.*injection_note.*does not name the identity harness/u,
  );
});

// Debt 10h (R6-20, a1): the package said every group is injected for real and
// that only F017–F020 touch Git directly. Eight fault-harness groups hand their
// guard a written observation, and no group of the fault harness runs a host
// driver or the daemon. How each group is injected is now data in the matrix,
// held to the harness that runs it, and the package renders it from there.

const INJECTION = Object.freeze({
  F001: "real_path", F002: "real_path", F003: "real_path", F004: "real_path",
  F005: "measured_observation", F006: "written_observation", F007: "written_observation",
  // Review of 10h (M1): F008 writes `ref` and `post_state`, F011 `exit_code`,
  // and F012's record cannot come out otherwise, so all three are written.
  F008: "written_observation", F009: "measured_observation", F010: "measured_observation",
  F011: "written_observation", F012: "written_observation", F013: "measured_observation",
  F014: "measured_observation", F015: "written_observation", F016: "written_observation",
  F017: "written_observation", F018: "written_observation", F019: "written_observation",
  F020: "written_observation",
});

test("every group declares how it is injected, as the harness that runs it does it", () => {
  const byId = Object.fromEntries(matrix().groups.map((group) => [group.id, group.injection]));
  assert.deepEqual(byId, INJECTION);
  for (const group of matrix().groups) {
    // A written observation names the fields the harness writes rather than reads.
    if (group.injection === "written_observation") assert.ok(group.written_fields.length > 0, group.id);
    else assert.equal(group.written_fields, undefined, group.id);
    // A fault-harness group names the guard it asks; a daemon group names none.
    if (group.injection === "real_path") assert.equal(group.guards, undefined, group.id);
    else assert.ok(group.guards.length > 0, group.id);
  }
});

test("a group with no injection kind is refused", () => {
  assertRejects(mutated((value) => { delete value.groups[0].injection; }), /injection/u);
  assertRejects(mutated((value) => { value.groups[0].injection = "real"; }), /injection/u);
});

test("a fault-harness case declared as a real daemon path is refused", () => {
  // F005 is a case of `scripts/clean-room-faults.mjs`: a guard asked about a
  // fixture, not the daemon answering on its own path.
  assertRejects(
    mutated((value) => { value.groups.find((group) => group.id === "F005").injection = "real_path"; }),
    /F005.*fault harness.*real_path/u,
  );
});

test("a group the fault harness does not run cannot claim an observation it never made", () => {
  assertRejects(
    mutated((value) => { value.groups.find((group) => group.id === "F001").injection = "measured_observation"; }),
    /F001.*no case in the fault harness/u,
  );
});

test("a written observation names its written fields, and the harness writes each one as a literal", () => {
  assertRejects(
    mutated((value) => { delete value.groups.find((group) => group.id === "F007").written_fields; }),
    /F007.*names no written field/u,
  );
  // F007 measures the observed OID; claiming it is written is a claim the case
  // source refutes.
  assertRejects(
    mutated((value) => { value.groups.find((group) => group.id === "F007").written_fields = ["observed_old_oid"]; }),
    /F007.*observed_old_oid.*not written as a literal/u,
  );
});

test("a measured group that names written fields is refused", () => {
  assertRejects(
    mutated((value) => { value.groups.find((group) => group.id === "F009").written_fields = ["untracked"]; }),
    /F009.*written_fields.*written_observation/u,
  );
});

test("the harness source decides, not the matrix: a case that stops writing a field fails the matrix", () => {
  const source = readFileSync(path.join(ROOT, "scripts/clean-room-faults.mjs"), "utf8");
  const measured = source.replace("observation, observed_old_oid: moved.trim() });", "observation, observed_old_oid: moved.trim(), reflog_entries: entries });")
    .replace("const observation = { ref: 'refs/heads/main', expected_old_oid: head, post_state: 'known', reflog_entries: 1 };",
      "const observation = { ref: 'refs/heads/main', expected_old_oid: head, post_state: 'known' };");
  assert.notEqual(measured, source);
  const errors = validateMatrix(matrix(), schema, { harnessSource: measured });
  assert.ok(errors.some((message) => /F007.*reflog_entries.*not written as a literal/u.test(message)), errors.join("\n"));
});

// Review of 10h (M1, Lows): every literal the faulted guard call is handed is
// declared — written, or fixed between the fault and its control — whatever
// the group's kind, and the literals are read from that call alone.

const group = (value, id) => value.groups.find((entry) => entry.id === id);

test("a literal handed to the guard and not declared is refused, whatever the kind", () => {
  assertRejects(
    mutated((value) => { group(value, "F008").written_fields = ["ref"]; }),
    /F008.*post_state is written as a literal in the guard call and is not declared/u,
  );
  assertRejects(
    mutated((value) => {
      const f011 = group(value, "F011");
      f011.injection = "measured_observation";
      delete f011.written_fields;
    }),
    /F011.*exit_code is written as a literal in the guard call and is not declared/u,
  );
  assertRejects(
    mutated((value) => { group(value, "F014").fixed_inputs = ["idle_ms"]; }),
    /F014.*wall_clock_ms is written as a literal in the guard call and is not declared/u,
  );
});

test("a harness edit that hands the guard a new literal fails the matrix", () => {
  const source = readFileSync(path.join(ROOT, "scripts/clean-room-faults.mjs"), "utf8");
  const edited = source.replace("observation, observed_old_oid: moved.trim() });", "observation, observed_old_oid: 'ffff' });");
  assert.notEqual(edited, source);
  const errors = validateMatrix(matrix(), schema, { harnessSource: edited });
  assert.ok(errors.some((message) => /F007.*observed_old_oid is written as a literal in the guard call and is not declared/u.test(message)), errors.join("\n"));
});

test("a declared field must be a literal of the guard call, not of the case around it", () => {
  // `detail` is a literal of F006's return value, not of what its guard is handed.
  assertRejects(
    mutated((value) => { group(value, "F006").written_fields.push("detail"); }),
    /F006.*detail is not written as a literal in the guard call/u,
  );
  assertRejects(
    mutated((value) => { group(value, "F014").fixed_inputs.push("detail"); }),
    /F014.*detail is not written as a literal in the guard call/u,
  );
});

test("a fault-harness group names a guard its case calls, and a daemon group names none", () => {
  assertRejects(mutated((value) => { delete group(value, "F009").guards; }), /F009.*names no guard/u);
  assertRejects(mutated((value) => { group(value, "F009").guards = ["noSuchGuard"]; }), /F009.*noSuchGuard is not called/u);
  assertRejects(mutated((value) => { group(value, "F001").guards = ["locationErrors"]; }), /F001.*guards belong to a fault-harness case/u);
});

test("the cases are the harness's CASES, not every function that looks like one", () => {
  const source = readFileSync(path.join(ROOT, "scripts/clean-room-faults.mjs"), "utf8");
  // A case function left out of CASES is not run, so it is no case.
  const dropped = source.replace("  F009: f009,\n", "");
  assert.notEqual(dropped, source);
  const errors = validateMatrix(matrix(), schema, { harnessSource: dropped });
  assert.ok(errors.some((message) => /F009.*no case in the fault harness/u.test(message)), errors.join("\n"));
});

// Debt 11f (R7-6, round 7 of #39): the contract that will define #36's release
// gate counted a group covered by a real fault only when its fault was
// detected and its control stayed silent, while the run counted all twenty.
// The run now follows the contract, so the contract names every state the run
// can give a group, says which one counts toward the gate, and the rule has a
// state for every injection kind the schema admits.

test("the contract names every coverage state, and only covered_by_real_fault counts toward the release gate", async () => {
  const { COVERAGE_STATES } = await import("../scripts/lib/clean-room-coverage.mjs");
  const contract = files[CONTRACT_PATH];
  for (const state of COVERAGE_STATES) assert.ok(contract.includes(`\`${state}\``), `${state} is not named`);
  assert.match(contract, /Only `covered_by_real_fault` counts toward the release gate \(#36\)/u);
  // The acceptance row says the same, rather than "covered by an injected fault".
  // Review of 11f (L4): F001–F003 are real injections too, so the row says
  // which state counts toward the gate, not which state was injected.
  const mapping = contract.slice(contract.indexOf("## 10."));
  assert.match(mapping, /\| Every fault group is covered by an injected fault, or reported as not covered \| §7 \(only `covered_by_real_fault` counts toward the gate as covered by an injected fault: the designed fault, met on the product path; every other state reports what is missing\), §9 \|/u);
  assert.doesNotMatch(mapping, /only `covered_by_real_fault` is covered by an injected fault/u);
  for (const state of COVERAGE_STATES) {
    const without = contract.replaceAll(`\`${state}\``, "`another_state`");
    assert.ok(
      validateCleanRoomDesign({ ...files, [CONTRACT_PATH]: without }).some((message) => message.includes(`coverage state ${state} is not named`)),
      state,
    );
  }
  // Debt 12e: and it says what the count requires — the designed fault, met on the product path.
  assert.match(contract, /the designed fault, met on the product path/u);
  const unqualified = contract.replaceAll("the designed fault, met on the product path", "a fault");
  assert.ok(validateCleanRoomDesign({ ...files, [CONTRACT_PATH]: unqualified }).some((message) => /designed fault.*product path/u.test(message)));
  const silent = contract.replace("Only `covered_by_real_fault` counts toward the release gate (#36)", "Every state counts");
  assert.ok(validateCleanRoomDesign({ ...files, [CONTRACT_PATH]: silent }).some((message) => /which coverage state counts toward the release gate/u.test(message)));
});

test("the coverage rule has a state for every injection kind the schema admits", async () => {
  const { INJECTION_KINDS } = await import("../scripts/lib/clean-room-coverage.mjs");
  const enumerated = schema.properties.groups.items.properties.injection.enum;
  assert.deepEqual([...enumerated].sort(), [...INJECTION_KINDS].sort());
  const widened = structuredClone(schema);
  widened.properties.groups.items.properties.injection.enum.push("replayed_observation");
  const errors = validateCleanRoomDesign({ ...files, [SCHEMA_PATH]: JSON.stringify(widened) });
  assert.ok(errors.some((message) => /replayed_observation.*no coverage state/u.test(message)), errors.join("\n"));
});
