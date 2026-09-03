<!-- generated-by: autosk-flow/ticket-markdown/v1 -->

# T02 — Expose the session API

**Work type:** feature

**Depends on:** T01

## Goal

Expose the approved session behavior through the API boundary.

## Acceptance criteria

- **AC-T02-001:** The session API reads and writes only through the approved session-store interface.

## Canonical manifest entry

```json
{
  "acceptance_criteria": [
    {
      "id": "AC-T02-001",
      "text": "The session API reads and writes only through the approved session-store interface.",
      "verification_bindings": [
        {
          "binding_id": "recipe:session-api",
          "expected_evidence": [
            "runtime_observation",
            "test_result"
          ],
          "kind": "recipe",
          "source_ref": "verification:current"
        }
      ]
    }
  ],
  "dependency_rationale": [
    {
      "dependency_id": "T01",
      "kind": "semantic",
      "reason": "The API compiles and verifies against the typed session-store interface introduced by T01."
    }
  ],
  "depends_on": [
    "T01"
  ],
  "document_path": "docs/autosk/epics/11111111-1111-4111-8111-111111111111/tickets/T02-session-api.md",
  "goal": "Expose the approved session behavior through the API boundary.",
  "governing_refs": [
    "brief:current",
    "core_flow:current",
    "tech_plan:current",
    "verification:current"
  ],
  "id": "T02",
  "impacts": {
    "documentation": {
      "paths": [
        {
          "kind": "file",
          "path": "docs/session-api.md"
        }
      ],
      "rationale": "The API request, response and failure behavior must be documented.",
      "status": "required"
    },
    "migration": {
      "paths": [],
      "rationale": "No persistent data format is changed.",
      "status": "none"
    },
    "observability": {
      "paths": [
        {
          "kind": "directory",
          "path": "src/telemetry"
        }
      ],
      "rationale": "API failures require a bounded diagnostic counter.",
      "status": "required"
    },
    "operations": {
      "paths": [],
      "rationale": "The API is part of the existing service process.",
      "status": "none"
    },
    "security": {
      "paths": [
        {
          "kind": "directory",
          "path": "src/api/session"
        }
      ],
      "rationale": "Session identifiers must be validated at the API boundary.",
      "status": "required"
    }
  },
  "in_scope": [
    "Session API handlers and contract tests.",
    "Validation and diagnostic counters for session failures."
  ],
  "lineage": {
    "kind": "new",
    "predecessor_ids": []
  },
  "material_decision_refs": [],
  "out_of_scope": [
    "Alternative session-storage implementations."
  ],
  "review_policy_ref": "review:cross-family:v1",
  "risk_and_rollback": {
    "approval_refs": [],
    "failure_modes": [
      "Invalid session identifiers can reach the storage boundary.",
      "The API can bypass the typed store and create divergent behavior."
    ],
    "irreversible": false,
    "risk_level": "high",
    "rollback_mode": "automatic",
    "rollback_steps": [
      "Remove the T02 delta from private staging before final target promotion."
    ]
  },
  "scope_selectors": [
    {
      "kind": "file",
      "path": "docs/session-api.md"
    },
    {
      "kind": "directory",
      "path": "src/api/session"
    },
    {
      "kind": "directory",
      "path": "src/telemetry"
    },
    {
      "kind": "directory",
      "path": "test/api/session"
    }
  ],
  "title": "Expose the session API",
  "work_contract_refs": [
    "work:feature:v1"
  ],
  "work_type": "feature"
}
```
