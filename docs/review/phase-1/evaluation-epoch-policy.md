# Evaluation epochs — lifecycle, frozen

Frozen before Epoch 2 is authored, so the rule cannot be shaped by what the
fixtures turn out to contain.

## What never changes

```
gate formulas            unchanged
gate thresholds          unchanged
precision requirement    unchanged
holdout denominator      8
required holdout recall  4/8
```

A failed epoch is never a reason to move a threshold. Epoch 1's published
false positive is evidence that the precision requirement is doing work, not
evidence that it is too strict.

## The lifecycle

```
created    before the capability work it will evaluate begins
sealed     by a manifest digest over canonical serialization
observed   exactly once
immutable  the first observation is recorded whatever it says
spent      immediately after that observation
```

An epoch is blinded validation evidence only while nobody implementing against
it has seen it. The moment it is observed, that property is gone permanently —
not because the cases changed, but because the people and processes that will
next modify the source now know what is in it.

## The consequence, stated as a rule

```
source changed after observing an epoch
  -> must be evaluated against a NEW, previously unseen epoch

P1-M may close only when a FROZEN source revision passes the UNCHANGED gate
against a FRESH epoch that was sealed before that capability's work began

every earlier failed epoch remains permanently reported
```

This is deliberately not "replace the test set until something passes". The
distinction is the direction of causation:

```
INVALID   the set failed          -> get a different set
VALID     the set was exposed     -> it can no longer blind-validate
                                     work done after the exposure
```

The second is ordinary experimental hygiene. What makes it honest rather than
convenient is the last line above: nothing is deleted, and the final report
shows every failure. Passing Epoch 2 will not rewrite Epoch 1.

## Roles

```
evaluator        authors and seals the epoch; opens it after source freeze
implementation   never sees epoch source, labels, anchors, or case
                 descriptions before its own freeze
coordinator      holds only the digest and inventory metadata
```

The implementation side may know that an epoch exists, its case count, and its
family distribution. That is experiment design, not leakage — it is what makes
a result interpretable at all — and it is deliberately not enough to build to.

### The residual limitation, stated rather than glossed

Storing fixtures outside the implementation worktree makes casual inspection
unlikely, not impossible. The separation is procedural, and it is only as good
as the discipline that keeps it. Recording that plainly is better than
implying a digest can hide a file from a process that can read the disk.

Epoch 1 had stronger independence than any later epoch will: it existed before
the capabilities were conceived. Later epochs should be read as somewhat
weaker evidence, and that weakening is itself part of the record.

## Registry

```
EPOCH 1   sealed before P1-M.2 · observed at M.3 source freeze d612eac
          historical 5/12 · development 2/8 · holdout 0/8 · published FP 1
          gate FAIL on 1, 2, 3, 7
          status SPENT — usable as regression evidence, never as blinded
          validation, and any replay is labelled a post-holdout regression
          replay earning no generalization credit

EPOCH 2   p1-m-epoch-2/returned-value-usage.v1
          sealed independently, before any M.4 source existed
          8 cases · 4 returned_value_usage · 4 cross-family
          cross-family: configuration_sensitive_type_safety,
                        public_api_compatibility,
                        sensitive_data_exposure,
                        deterministic_serialization
          manifest digest bee7cd8e66b788d4664c58578f82ec88b203e760d0f7c78a568ee587728c82c9
          stored at /home/shrenil/Desktop/acalys-evaluator/epoch-2/ (outside this repo)
          seal verified independently by the coordinator: SEAL INTACT
          status SEALED — never observed
```

## Epoch 2 scoring instruction, binding at evaluation time

The evaluator reports that `M1ExpectedFinding` cannot express an enumeration
of allowed anchors, so each case carries its true enumeration in
`EPOCH2_ANCHOR_POLICY` while `expectedFindings[0]` holds the minimal **hull**
of that enumeration, present only so the frozen overlap matcher runs
unchanged.

Scoring must use the enumeration, not the hull.

The overlap matcher accepts any candidate whose span touches the expected
span. Two allowed anchors at lines 3 and 7 produce a hull of 3–7, and a
finding published at line 5 would then score as correct while pointing at
nothing. That is precisely how Epoch 1's historical result was partly earned —
a 1–4 allowed span blessed a hardcoded line-1 anchor — and it is the defect
M.3.3 exists to have repaired.

The evaluator states the seal refuses to build a hull wider than its
enumeration, which if every enumeration is contiguous makes the two identical.
That cannot be confirmed without reading the fixtures, and the coordinator must
not. So the instruction is unconditional rather than contingent: at evaluation
time, a candidate counts only if its anchor is one of the enumerated allowed
anchors. The hull is never the acceptance criterion.

## Epoch 2 measures something Epoch 1 could not

Two of the four cross-family cases sit in families with shipped capabilities
(`configuration_sensitive_type_safety`, `public_api_compatibility`), so this
epoch can ask whether M.2 and M.3 generalize. Epoch 1 could not, by
construction — seven of its eight rows were out of scope for everything
implemented.

The other two cross-family cases are in unimplemented families and can only
cost precision, never add recall. A perfect M.4 therefore reaches at least
`4/8` — the frozen threshold — and up to `6/8` if the shipped capabilities
generalize. The threshold was not adjusted to fit this; it has been frozen
since M.1.
