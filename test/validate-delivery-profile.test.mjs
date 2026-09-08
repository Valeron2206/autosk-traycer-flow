/**
 * Tests for the issue #17 delivery-profile validator.
 *
 * Each case mutates the worked example in exactly one way and asserts the check
 * that should catch it fires. The profile's whole purpose is to be answered
 * before the first implementation dispatch, so a check that never fires is a
 * question that was never really asked.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  CONTRACT_PATH,
  EXAMPLE_PATH,
  PARK_REASONS,
  ROOT,
  SCHEMA_PATH,
  UNRESOLVED_REASONS,
  canonicalValue,
  deliveryProfileDesignDigest,
  loadFiles,
  profileDigest,
  validateDeliveryProfileDesign,
  validateProfile,
} from "../scripts/validate-delivery-profile.mjs";

const files = loadFiles();
const schema = JSON.parse(files[SCHEMA_PATH]);

function example() {
  return JSON.parse(files[EXAMPLE_PATH]);
}

function mutated(mutate, { reseal = true } = {}) {
  const profile = example();
  mutate(profile);
  if (reseal) profile.profile_digest = profileDigest(profile);
  return profile;
}

function assertRejects(profile, pattern) {
  const errors = validateProfile(profile, schema);
  assert.ok(
    errors.some((message) => pattern.test(message)),
    `expected an error matching ${pattern}, got:\n${errors.join("\n") || "(none)"}`,
  );
}

test("the shipped design validates", () => {
  assert.deepEqual(validateDeliveryProfileDesign(files), []);
});

test("the example profile validates and its digest recomputes", () => {
  const profile = example();
  assert.deepEqual(validateProfile(profile, schema), []);
  assert.equal(profile.profile_digest, profileDigest(profile));
});

test("a review-only project cannot also be permitted to move the target", () => {
  // The criterion the issue states in as many words, and the one a hidden
  // fallback would quietly break.
  assertRejects(
    mutated((profile) => {
      profile.target.direct_push_allowed = true;
      profile.integration.allowed_modes = ["pull_request"];
    }),
    /cannot also be permitted to move the target/u,
  );
});

test("a merge queue cannot be required without being an allowed mode", () => {
  assertRejects(
    mutated((profile) => {
      profile.integration.merge_queue_required = true;
    }),
    /merge_queue is not an allowed mode/u,
  );
});

test("a review mode cannot coexist with pull_request:not_applicable", () => {
  assertRejects(
    mutated((profile) => {
      profile.integration.pull_request = "not_applicable";
    }),
    /not_applicable when a review mode is allowed/u,
  );
});

test("an unknown binding field must be declared, or it would be decided by default", () => {
  assertRejects(
    mutated((profile) => {
      profile.authorship.signing = "unknown";
    }),
    /unknown but not recorded in unresolved/u,
  );
});

test("a declared unresolved field must actually be unresolved", () => {
  assertRejects(
    mutated((profile) => {
      profile.unresolved.push({ field: "authorship/dco", reason: "discovery_unavailable" });
    }),
    /recorded as unresolved but holds/u,
  );
});

test("declaring an unknown field resolves the objection, and moves identity", () => {
  const declared = mutated((profile) => {
    profile.authorship.signing = "unknown";
    profile.unresolved.push({ field: "authorship/signing", reason: "discovery_unavailable" });
  });
  assert.deepEqual(validateProfile(declared, schema), []);
  assert.notEqual(declared.profile_digest, example().profile_digest);
});

test("an unresolved reason outside the closed set is refused", () => {
  assertRejects(
    mutated((profile) => {
      profile.unresolved.push({ field: "authorship/signing", reason: "looked_hard" });
    }),
    /schema:|is not a recordable reason/u,
  );
});

test("a binding field whose section has no provenance is a field with no source", () => {
  // Section 3: every recorded field names the source it came from, and that is
  // the one thing the profile is not allowed to leave open.
  // The schema requires provenance for the sections it names, so the case this
  // rule catches is a profile that binds on a section which has none —
  // `release`, here, whose exclusion a project could well make binding.
  assertRejects(
    mutated((profile) => {
      profile.binding_fields.push("release/deploy_excluded");
    }, true),
    /release\/deploy_excluded is binding and its section has no provenance/u,
  );
});

test("binding_fields cannot name a field the profile does not contain", () => {
  assertRejects(
    mutated((profile) => {
      profile.binding_fields.push("integration/no_such_field");
    }),
    /which the profile does not contain/u,
  );
});

test("remote discovery without an expiry is refused: it is evidence with a shelf life", () => {
  assertRejects(
    mutated((profile) => {
      delete profile.provenance.target.expires_at;
    }),
    /must record observed_at and expires_at/u,
  );
});

test("an expiry that precedes the observation is refused", () => {
  assertRejects(
    mutated((profile) => {
      profile.provenance.checks.expires_at = "2026-09-08T05:00:00Z";
    }),
    /expires_at must be after observed_at/u,
  );
});

test("project config must name the blob it was read from", () => {
  assertRejects(
    mutated((profile) => {
      delete profile.provenance.integration.blob_oid;
    }),
    /project_config must record the blob_oid/u,
  );
});

test("a human decision must record its id and its scope", () => {
  assertRejects(
    mutated((profile) => {
      delete profile.provenance.remotes.decision_scope;
    }),
    /human_decision must record decision_id and decision_scope/u,
  );
});

test("a required check must say where it came from", () => {
  assertRejects(
    mutated((profile) => {
      delete profile.checks.required[0].provenance;
    }),
    /schema:|must name where it came from/u,
  );
});

test("deployment cannot be un-excluded", () => {
  assertRejects(
    mutated((profile) => {
      profile.release.deploy_excluded = false;
    }),
    /schema:|deploy_excluded must be true/u,
  );
});

test("a digest that does not recompute is refused", () => {
  assertRejects(
    mutated(
      (profile) => {
        profile.target.target_ref = "refs/heads/release";
      },
      { reseal: false },
    ),
    /profile_digest does not recompute/u,
  );
});

test("the same set in a different order is not drift", () => {
  // Every array here is a set. Serialising positionally would make a
  // re-resolution that returned the same permissions in a different order look
  // like drift — and drift invalidates approvals that nothing was wrong with.
  const before = profileDigest(example());
  const after = profileDigest(
    mutated(
      (profile) => {
        profile.integration.allowed_modes = [...profile.integration.allowed_modes].reverse();
      },
      { reseal: false },
    ),
  );
  assert.equal(before, after);
});

test("a different set is drift", () => {
  const before = profileDigest(example());
  const after = profileDigest(
    mutated(
      (profile) => {
        profile.integration.allowed_modes = ["merge"];
      },
      { reseal: false },
    ),
  );
  assert.notEqual(before, after);
});

test("the file must still be written in canonical order", () => {
  // Order-insensitive identity must not become permission to write the file any
  // way at all: two profiles with the same content should be the same bytes, so
  // a diff shows a real change rather than a reshuffle.
  assertRejects(
    mutated((profile) => {
      profile.integration.allowed_modes = ["squash", "pull_request"];
    }),
    /must be written in canonical \(sorted\) order/u,
  );
});

test("canonical serialisation sorts nested keys as well as arrays", () => {
  assert.equal(canonicalValue({ b: 1, a: [3, 1, 2] }), '{"a":[1,2,3],"b":1}');
  assert.equal(canonicalValue([{ b: 2, a: 1 }]), '[{"a":1,"b":2}]');
  assert.equal(canonicalValue(undefined), "undefined");
});

test("a non-binding field can be reworded without invalidating a candidate", () => {
  // The reason the digest covers binding_fields rather than the whole document:
  // a rationale must be editable without invalidating work that never depended
  // on it.
  const before = profileDigest(example());
  const after = profileDigest(
    mutated(
      (profile) => {
        profile.rollback = `${profile.rollback} (reworded, same path)`;
      },
      { reseal: false },
    ),
  );
  assert.equal(before, after);
});

test("adding a required check moves identity", () => {
  // The other direction: a check appearing mid-run must invalidate a staging
  // result that never ran it. It can only do that if it is binding.
  const profile = mutated(
    (draft) => {
      draft.checks.required.push({
        name: "autosk / darwin-arm64",
        provenance: {
          source: "remote_discovery",
          observed_at: "2026-09-08T06:00:00Z",
          expires_at: "2026-09-08T07:00:00Z",
        },
      });
      draft.binding_fields.push("checks/required");
    },
    { reseal: false },
  );
  assert.notEqual(profileDigest(profile), profileDigest(example()));
});

test("the schema cannot hold a credential", () => {
  // Section 8 is a claim about the schema, not a policy. A field named for a
  // secret would make it false, so the design validator checks it.
  const serialised = JSON.stringify(schema);
  for (const forbidden of ["token", "password", "secret", "private_key", "passphrase"]) {
    assert.ok(
      !new RegExp(`"[a-z_]*${forbidden}[a-z_]*"\\s*:\\s*\\{`, "u").test(serialised),
      `the schema defines a field matching ${forbidden}`,
    );
  }
  // `credential_class` names a class, never a value, and that distinction is
  // what makes the claim survivable.
  assert.deepEqual(schema.properties.remotes.properties.credential_class.enum, [
    "none",
    "forge_token",
    "ssh_key",
    "unknown",
  ]);
});

test("every park reason is documented, and the recordable ones are a subset", () => {
  const contract = readFileSync(path.join(ROOT, CONTRACT_PATH), "utf8");
  for (const reason of PARK_REASONS) {
    assert.ok(contract.includes(reason), `${reason} is not documented`);
  }
  for (const reason of UNRESOLVED_REASONS) {
    assert.ok(PARK_REASONS.includes(reason), `${reason} is recordable but not a park reason`);
  }
});

test("the design digest changes when any of the three files changes", () => {
  const before = deliveryProfileDesignDigest(files);
  const after = deliveryProfileDesignDigest({ ...files, [CONTRACT_PATH]: `${files[CONTRACT_PATH]}\n` });
  assert.notEqual(before, after);
});
