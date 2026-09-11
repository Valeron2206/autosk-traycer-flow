# Closed park vocabulary contract

<!-- refusal-vocabulary-contract:v1 -->

Status: issue #4 runtime contract. The design says a workflow parks in `human` with a named reason and never with a sentence. Panel round 1 found that claim asserted in three documents at once — `01-core-flows.md` §8, `03-technical-plan.md` §7 and the contracts — with nothing enumerating the reasons and nothing checking them. Three seats reported it independently, which is what a rule with no mechanism looks like from the outside.

## 1. Authority

A park reason is a machine field. A caller branches on it, a resume path is chosen by it, and a recovery table is keyed on it. So the set of reachable park states has to be finite, written down, and derived from the place the design decides it — not restated in a second list somebody maintains.

The resume contract in `03-technical-plan.md` §7 is that place. This contract makes the vocabulary an extraction from that table, checked against the workflow graphs the same document registers.

## 2. Boundaries

This contract decides what a park reason must satisfy to exist. It does not decide what any individual reason means — that belongs to the contract that owns the reason — and it does not decide when a workflow parks.

## 3. The vocabulary is extracted, not maintained

The closed JSON Schema is `resources/refusal-vocabulary/refusal-vocabulary.schema.json`; the vocabulary is `resources/refusal-vocabulary/refusal-vocabulary.v1.json`.

Every entry comes from a row of the resume contract. The checked-in resource is the enumeration a reviewer reads, and a difference between it and the table is `refusal_vocabulary_drift` — not a merge. A second list that can quietly disagree with the first is the failure this contract exists to prevent, so the resource never wins an argument with the table.

The step column of that table is written for a person and carries qualifying prose, so only tokens naming a registered step are taken from it. A misspelled step is therefore not accepted quietly: its row ends up naming no step at all, and a reason that names nowhere is `refusal_vocabulary_unknown_step`.

The fields holding them are `named_at` and `named_at_classes`, and the name is the point: what the table names for a reason is not the same statement as where the graph parks it. The graph document splits those two — `parks_at` for where it stops, `handled_at` for where the reason is dealt with — and a class the table names can straddle the split, so this resource carries what it actually extracted and lets the graph contract own the other statement.

## 4. A park reason parks at a step that exists

Steps come from the registered workflow graphs in `03-technical-plan.md` §2, read from the graphs rather than from a list, because a hand-kept list of steps is a second place for the truth to live.

A reason may name steps directly, or name a step class when the parking step depends on which gate was running. Classes are declared with their derivation: `listed` members, a `prefix:` rule, or `complement:` another class. A `complement:` class is recomputed and compared, so "everything else" cannot drift into a list somebody edits. A class the resource does not declare is `refusal_vocabulary_unknown_class`.

## 5. Who parks is recorded, not implied

Most of these reasons are parked by the daemon, which is not in this repository. Saying otherwise would make the enumeration look better checked than it is, so each entry records `producer`, and the claim is contradicted where the repository disagrees:

- a `host` entry names files, and a named file that does not contain the code is `refusal_vocabulary_producer_missing`;
- a `daemon` entry names none, and a `daemon` entry the repository does in fact produce is `refusal_vocabulary_producer_misdeclared`.

Matching is whole-word: a short code is a suffix of longer ones, and a file that only ever writes the longer code does not produce the short one.

## 6. Every park reason has one owner

Most of these reasons are the workflow's own vocabulary: they belong to the resume contract in `03-technical-plan.md` §7 and to no artifact. Seventeen of the eighty-four are additionally closed by the artifact contract they belong to.

Either way the owner is a recorded field, not something a reader infers. "Somebody must have closed this somewhere" is exactly how a code with no owner survives, so an entry with no `closed_by`, or one naming a document that does not close it, is `refusal_vocabulary_owner_missing`.

A name two contracts declare has no single owner — and therefore no single producer and no single step, which is what the rest of this contract checks. That is `refusal_vocabulary_owner_ambiguous`, and it is refused rather than resolved by precedence: a caller branching on the name cannot tell which of the two conditions it got.

## 7. Every contract closes its set, and the user-facing table maps

A contract that declares no closed refusal set leaves its vocabulary open-ended, and a caller has nothing to branch on: `refusal_vocabulary_unclosed_contract`.

`01-core-flows.md` §8 is written for a person and mostly describes situations. Where it does name a machine code, that code is a park state like any other and must be in the vocabulary: `refusal_vocabulary_code_unmapped`.

## 8. Refusal classes

Closed set: `refusal_vocabulary_drift`, `refusal_vocabulary_unknown_step`, `refusal_vocabulary_unknown_class`, `refusal_vocabulary_producer_missing`, `refusal_vocabulary_producer_misdeclared`, `refusal_vocabulary_code_unmapped`, `refusal_vocabulary_unclosed_contract`, `refusal_vocabulary_owner_missing`, `refusal_vocabulary_owner_ambiguous`, `refusal_vocabulary_digest_stale`.

## 9. What this contract decides, and what it defers

Decided: that the vocabulary is finite and extracted, that every reason parks at a registered step or a declared class, that the owner and the producer are recorded rather than implied, that no name is declared by two contracts, and that every contract closes its own set.

Deferred, and named: the daemon side. Seventy-one of the reasons are parked by `autoskd`, and this repository can check that they are declared, enumerated and bound to a real step — it cannot check that the daemon emits them. That belongs to the daemon's own tests, and no count here should be read as covering it.
