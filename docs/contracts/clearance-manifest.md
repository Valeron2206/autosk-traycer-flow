# Clearance manifest contract

<!-- clearance-manifest-contract:v1 -->

Status: issue #20 design contract. The scanner runtime and the send-layer check are `required_for_v1`; this pins what must be true before a single byte reaches a provider.

## 1. Authority

`autosk-flow` sends user instructions, code and context extracts, artifacts and operational facts to external provider harnesses. Scanning the *source files* before the prompt is compiled does not establish that the prompt is safe: dangerous fragments appear when fragments are joined, when a template substitutes, and in diagnostics and attribution that no source file contains.

And a `grep` for `secret`, `token` or `password` is both noisy and blind — it flags prose and misses an actual key. So the scan is of the **exact serialized bytes**, with a real scanner, and its own failure is never read as a pass. The closed JSON Schema is `resources/clearance-manifest/clearance-manifest.schema.json`.

## 2. The order is the guarantee

```text
compile the final serialized PromptEnvelope
→ build clearance-manifest.json
→ scanner self-test (once per tool/version/config/environment)
→ scan the exact serialized bytes
→ separate personal/client-data policy check
→ deterministic redactions
→ re-serialize and re-scan
→ record the sanitized body digest and manifest, never the raw bytes
→ only then call the provider
```

Every step is after the one before it for a reason, and two are worth naming. The scan is after serialization because that is the only artefact that will actually be sent. And the re-scan is after redaction because a redaction changes the bytes, and the bytes are what was being vouched for.

## 3. The scanner, and what its silence means

- a repository-configured scanner is preferred when it can take the exact body on stdin; `gitleaks stdin` is the fallback;
- the tool, its version, its config digest and its exit classification are recorded;
- the **self-test** runs once per tool, version, config and environment: a fixed high-entropy fake token must be reported as a leak, and a clean fixture must exit 0. A scanner that cannot find a planted secret is not evidence that there is none;
- a launch failure, a non-zero exit that is not a finding, a malformed report or a timeout is `unknown` — **never** `clean`. This is the whole shape of the issue: the provider is not called on a result nobody understood;
- a generic keyword grep is not admissible as evidence, on its own or as a fallback. It is allowed as an extra signal and never as the one that clears a dispatch.

## 4. Personal and client data are a separate check

A secret scanner looks for credentials. A client name, an email address, an account identifier or a customer excerpt is none of those, and a scanner that passes says nothing about them. So the policy check is its own step with its own disposition, and a dispatch needs both.

## 5. The manifest

Included source logical ids and hashes; excluded and redacted fragments with reasons; the scanner evidence; the personal/client-data disposition; the artifact, candidate and anchor identity; the sanitized body digest; the dispatch and attempt identity; and an approved exception when one exists.

**No secret value appears in the manifest.** A record of what was found that quotes what was found has moved the secret rather than removed it — into a file that is kept longer and read more widely than the prompt ever was.

## 6. Data policy

- absolute home and user paths are redacted or replaced by logical locators;
- raw transcripts and logs are not sent whole without clearance;
- a tracked file that is also ignored is ordinary tracked content. `.gitignore` is not a protection boundary, and treating it as one is how an ignored-but-tracked secret ships;
- a binary or non-UTF-8 attachment gets its own classification and snapshot policy (#21), because a scanner reading it as text proves nothing;
- an exception is approved by the user for the **exact current scope**. It names the dispatch it covers and does not become a standing waiver; an exception whose scope no longer matches is stale and does not apply.

## 7. The send layer checks again

Immediately before the provider call, the send layer recomputes the digest of what it is about to send and compares it with the manifest. Anything else means the bytes that were cleared and the bytes that are sent were only assumed to be the same — and the window between them is exactly where a source mutation lands.

## 8. Refusal classes

- `clearance_scanner_missing`;
- `clearance_scanner_selftest_failed`;
- `clearance_scanner_unknown_result`;
- `clearance_secret_found`;
- `clearance_personal_data_unreviewed`;
- `clearance_digest_mismatch`;
- `clearance_manifest_contains_secret`;
- `clearance_exception_stale`;
- `clearance_binary_unclassified`;
- `clearance_keyword_grep_as_evidence`.

## 9. What this contract decides, and what it defers

Decided: the order, what the scanner must prove about itself, what its silence means, the separation of personal-data review, the manifest, the data policy and the send-layer re-check.

Deferred, and named: the scanner adapter, the redaction engine and the dispatch path that calls them.
