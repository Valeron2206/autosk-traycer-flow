/**
 * How a clean-room fault group was covered (#36, debt 11f, ADR-100).
 *
 * `clean-room-e2e.md` §7 counts a group as covered by a real fault only when
 * its fault was detected and its control stayed silent, and the run used to
 * count all twenty groups that way — three of them ask no control, and eleven
 * hand their guard an observation the harness wrote. A group's state now says
 * how it was covered, read from three things: the matrix's `injection` for the
 * group, whether the run detected the fault, and whether a control was asked
 * and stayed silent. Only the first state counts toward the release gate.
 *
 * Debt 12e (R8-7, R8-12): counting a detected fault with a silent control was
 * still not counting the *designed* fault on the *product path*. F002 and F003
 * name a daemon restart and a transcript write their notes say the run does not
 * do, and the five `measured_observation` groups hand a pure host function
 * values read from a fixture while no host driver, daemon or helper runs. A
 * group now counts only when its injection is `real_path` — the built daemon
 * answering on its own path — and the matrix says the run is the fault the
 * group designs (`injection_matches_design`); a real_path group whose run is a
 * substitute is `covered_by_substitute_fault` (a control that did not stay
 * silent ranks first: `control_failed`), and a measured group is
 * `covered_by_host_function`, reported as what it is.
 *
 * The rule and the coverage report built on it live here, shared by the run
 * (`scripts/clean-room-e2e.mjs`), the design validator
 * (`scripts/validate-clean-room-e2e.mjs`), which holds the contract to these
 * states and the schema's kinds to this rule, and the panel package, which
 * recomputes a run's coverage from the run's own records with these functions
 * and refuses a report that says anything else (review of 11f, M1) — so the
 * three cannot read a run differently. It imports nothing.
 */

/** The states, in the order a row falls through them from the best. */
export const COVERAGE_STATES = Object.freeze([
  // The designed fault met the product path (`real_path`, and the matrix says
  // the run is the fault the group designs), was detected, and the same guard
  // asked about the un-faulted state stayed silent.
  'covered_by_real_fault',
  // The same, with no control asked: nothing rules out a guard that would
  // refuse the un-faulted state too.
  'covered_without_control',
  // The run made a fault on the product path, and it is not the designed one
  // (the matrix's `injection_matches_design` is false): a substitute, which
  // says nothing about the fault the group names — a silent control included;
  // a control that did not stay silent is `control_failed`, which ranks first.
  'covered_by_substitute_fault',
  // A host function answered values read from a fixture the harness faulted:
  // no host driver, daemon or helper ran, so the product path did not meet it.
  'covered_by_host_function',
  // The guard was handed an observation the harness wrote and answered it:
  // an answer to a described state, not to the fault.
  'covered_by_written_observation',
  // Detected, and the control did not stay silent: the detection says nothing.
  'control_failed',
  // No harness reported the group, or its fault was not detected.
  'not_covered',
]);

/** The only kind whose fault meets the product path: the built daemon answers on its own path (§9). */
export const PRODUCT_INJECTION = 'real_path';

/** The kind whose guard is handed values read back from a fixture the harness faulted. */
export const MEASURED_INJECTION = 'measured_observation';

/** The kind whose guard is handed the fields the harness writes. */
export const WRITTEN_INJECTION = 'written_observation';

/** Every kind this rule gives a state to; the matrix schema admits exactly these. */
export const INJECTION_KINDS = Object.freeze([PRODUCT_INJECTION, MEASURED_INJECTION, WRITTEN_INJECTION]);

/**
 * The state of one group: `group` carries the matrix's `injection` and
 * `injection_matches_design` (only `true` says the run is the designed fault),
 * and `observation` what the run reported — the harness that ran it, whether the
 * fault was `detected`, and `control`: `true` when a control was asked and
 * stayed silent, `false` when it was asked and did not, `null` when none was
 * asked. A kind the rule does not know counts for nothing.
 */
export function coverageState(group, observation) {
  if (!observation?.harness || observation.detected !== true) return 'not_covered';
  if (observation.control === false) return 'control_failed';
  if (group?.injection === WRITTEN_INJECTION) return 'covered_by_written_observation';
  if (group?.injection === MEASURED_INJECTION) return 'covered_by_host_function';
  if (group?.injection !== PRODUCT_INJECTION) return 'not_covered';
  if (group.injection_matches_design !== true) return 'covered_by_substitute_fault';
  return observation.control === true ? 'covered_by_real_fault' : 'covered_without_control';
}

/**
 * Which harness covers which fault-matrix group, and what its run must show.
 *
 * A table is a claim; a run is evidence. So this table declares no detection
 * for any group (debt 11f, R7-6: it used to declare F001–F004 covered by a real
 * fault, so a run whose crash or identity harness failed, or never ran, still
 * counted them). F001–F004 name the daemon harness that makes their fault and
 * what that harness's summary must carry for the group — the crash points
 * killed, or the identity harness's group and control — and `harnessCoverage`
 * reads them from the run. F005–F020 name nothing: the fault harness covers
 * them, and `faultCoverage` derives their entries from what its run detected.
 */
export const COVERAGE = Object.freeze({
  // The crash harness injects at two points of a write and never asks the
  // un-faulted question, so its groups are covered without a control — the
  // difference between "injected" and "shown to be specific", which the panel
  // read as a completeness claim the run did not support.
  F001: { harness: 'crash', evidence: 'reservation.before / reservation.after', points: Object.freeze(['reservation.before', 'reservation.after']) },
  F002: { harness: 'crash', evidence: 'task.before / task.after', points: Object.freeze(['task.before', 'task.after']) },
  F003: { harness: 'crash', evidence: 'activation.before / activation.after', points: Object.freeze(['activation.before', 'activation.after']) },
  F004: {
    harness: 'identity',
    // The identity harness does run the control — the same bytes resume the
    // task — and reports it; the group is the swap its evidence names.
    evidence: 'a real resume under swapped bytes keeps the admitted pin, and the same bytes resume the task cleanly',
    fault: 'F004',
  },
  F005: { harness: null, evidence: null },
  F006: { harness: null, evidence: null },
  F007: { harness: null, evidence: null },
  F008: { harness: null, evidence: null },
  F009: { harness: null, evidence: null },
  F010: { harness: null, evidence: null },
  F011: { harness: null, evidence: null },
  F012: { harness: null, evidence: null },
  F013: { harness: null, evidence: null },
  F014: { harness: null, evidence: null },
  F015: { harness: null, evidence: null },
  F016: { harness: null, evidence: null },
  F017: { harness: null, evidence: null },
  F018: { harness: null, evidence: null },
  F019: { harness: null, evidence: null },
  F020: { harness: null, evidence: null },
});

/**
 * Coverage entries the daemon harnesses' own run gives F001–F004.
 *
 * A harness whose step is not in the run ran nothing, and its groups get no
 * entry: their rows name no harness (review of 11f, L3). A step that ran gives
 * each of its groups an entry, detected only when the step passed and its
 * summary names the group — both crash points of a crash group, the group and
 * the control of the identity harness — and the evidence says which: the
 * group's own when it was detected, the step's failure or what the summary
 * left out when it was not. The crash harness asks no control (`null`); the
 * identity harness's control is the one it reports.
 */
export function harnessCoverage(steps = []) {
  const stepOf = (harness) => steps.find((entry) => entry?.step === `harness:${harness}`) ?? null;
  const summaryOf = (step) => (step?.ok === true ? (step.summary ?? null) : null);
  const crashStep = stepOf('crash');
  const identityStep = stepOf('identity');
  const crash = summaryOf(crashStep);
  const identity = summaryOf(identityStep);
  const points = new Set((crash?.cases ?? []).map((entry) => entry?.point));
  const entries = {};
  for (const [id, declared] of Object.entries(COVERAGE)) {
    if (declared.harness === 'crash' && crashStep !== null) {
      const unreported = declared.points.filter((point) => !points.has(point));
      const detected = crash !== null && unreported.length === 0;
      entries[id] = Object.freeze({
        harness: 'crash',
        evidence: detected ? declared.evidence
          : crash === null ? 'the crash harness step failed'
            : `the crash harness passed without reporting ${unreported.join(' and ')}`,
        detected,
        control: null,
      });
    } else if (declared.harness === 'identity' && identityStep !== null) {
      const detected = identity?.evidence?.fault === declared.fault;
      const control = detected && typeof identity.evidence.control === 'string' && identity.evidence.control.length > 0;
      entries[id] = Object.freeze({
        harness: 'identity',
        evidence: detected ? declared.evidence
          : identity === null ? 'the identity harness step failed'
            : `the identity harness passed without reporting ${declared.fault}`,
        detected,
        control: control ? true : null,
      });
    }
  }
  return Object.freeze(entries);
}

/**
 * Coverage entries derived from a fault-harness run.
 *
 * Every case asks its control, so `control` is whether it stayed silent. A
 * guard that refuses everything detects every fault and means nothing by it,
 * so a failed control demotes the row (`control_failed`) rather than being
 * reported alongside it.
 */
export function faultCoverage(report) {
  const entries = report.results.map((entry) => [
    entry.id,
    Object.freeze({
      harness: 'faults',
      evidence: entry.detail,
      detected: entry.detected === true,
      control: entry.control === true,
    }),
  ]);
  return Object.freeze(Object.fromEntries(entries));
}

/**
 * The coverage report: each group's state, read from the matrix's `injection`
 * and what the run observed (`coverageState`), with the count of every state.
 * `coverage` holds the run's entries — `harnessCoverage` and `faultCoverage` —
 * and a group with none is not covered.
 */
export function coverageReport(matrix, coverage = {}) {
  const rows = matrix.groups.map((group) => {
    const entry = coverage[group.id] ?? null;
    return Object.freeze({
      id: group.id,
      boundary: group.boundary,
      injection: group.injection ?? null,
      // Whether the run is the fault the group designs: only `true` counts.
      injection_matches_design: group.injection_matches_design === true,
      state: coverageState(group, entry),
      harness: entry?.harness ?? null,
      evidence: entry?.evidence ?? null,
      detected: entry?.detected === true,
      // Whether the un-faulted question was asked, and answered silently.
      // Carried on the row so a reader is not left to infer specificity from
      // injection: `null` is "not asked", which is not "failed".
      control: entry?.control === true ? true : entry?.control === false ? false : null,
    });
  });
  // Every state is counted, zero included: a state no row is in is a fact too.
  const counts = Object.fromEntries(COVERAGE_STATES.map((state) => [state, rows.filter((row) => row.state === state).length]));
  return Object.freeze({
    rows: Object.freeze(rows),
    counts: Object.freeze(counts),
    // Stated rather than rounded up: only `covered_by_real_fault` — the
    // designed fault, met on the product path — counts toward the release
    // gate (#36), and a run is complete only when every group is in it.
    complete: rows.every((row) => row.state === 'covered_by_real_fault'),
    // Injection and specificity are different claims, so they are counted
    // separately rather than folded into one word.
    controlled: rows.filter((row) => row.control === true).length,
  });
}
