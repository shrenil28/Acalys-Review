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

EPOCH 2   authored independently before returned_value_usage begins
          status PENDING
```
