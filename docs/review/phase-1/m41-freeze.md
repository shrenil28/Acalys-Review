# P1-M.4.1 — frozen

Gate measurement integrity. No analyzer, verifier, or capability source
changed.

```
source freeze            3f081c1
```

## Evidence

```
verify                   EXIT=0 · 2,506 tests / 0 skipped · 338 modules / 0 violations
manifest preflight       274 declared · 274 matched uniquely ·
                         274 change source · 0 invalid before execution
mutation execution       274/274 detected · 272 semantic assertion kills ·
                         2 setup kills (#8, #58) · 0 survived · 0 invalid
targeted band            6/6 killed
```

### The second setup kill, checked rather than accepted

`#8` was a semantic kill in every previous full run and a setup kill in this
one, with `executed 0, skipped 14` — its suite never started. Re-run alone it
dies semantically at `11 failed | 3 passed (14)`.

This is the second time this has happened, and always to the same suite:
`#4` degraded the same way during the M.3.3 run and was semantic again
afterwards. Both are database-backed, and `#58` names the cause — every suite
shares one database name. It is a harness hygiene problem, not lost
protection, and the honest number for this run is 272 semantic kills with two
verified separately.

## What changed

Two gate inputs arrived from the caller with no definition anywhere in the
repository, which meant their interpretation could be chosen after seeing the
result. That is the goal-post problem surviving inside the executable gate
built to prevent it.

**Condition 7 derives its own formula.**

```
added true positives  = (historical TP - 2) + holdout TP
added comments        = added TP + historical FP + holdout FP
```

Taken from the contract's ECONOMICS line and the L.5 baseline of two published
true positives, and validated against Epoch 1's recorded `0.75` alone. Epoch
2's `1.0` is a consequence of the formula, never an input to choosing it.

Excluding the development split is forced rather than preferred: including it
yields `4/5 = 0.80`, contradicting the record. The contract agrees — perfect
scores on the visible fixtures alone cannot close P1-M.

**Condition 6 attributes its rejects.**

```
incorrect_verifier_reject   inside the frozen contract, refused anyway
capability_recall_miss      a family-level defect the capability never claimed
```

Both cost recall; conditions 1 and 2 already feel them. Only the first is
evidence of a broken verifier. Epoch 2's single refutation was the second and
was reported as the first, which would have sent the next checkpoint to repair
something that was working as specified.

## One existing expectation changed, and the change is the proof

`3. refuses a single published false positive` now fails `[3, 7]` rather than
`[3]`. A published false positive genuinely grows condition 7's denominator
without its numerator. While those numbers arrived from the caller, a
checkpoint could report a published false positive and a perfect yield ratio
in the same breath.

## A mutation that survived for an instructive reason

`#273` dropped holdout true positives from the numerator and survived the
first pass. With no published false positives, `comments == truePositives`,
so the ratio is `1.0` whatever the numerator — the mutation scaled both sides
equally and hid itself. A fixture carrying a published false positive is what
makes the numerator observable at all.

Classified `test_weakness`, fixed by adding that fixture rather than by
changing the guard.

## Epoch 2 is not amended

Its first observation still reads `FAIL 1, 2, 3, 6`. An addendum records that
the attribution machinery was found defective and that future epochs use the
corrected implementation — the same pattern as anchor policy 1 to policy 2:
the past measurement stays past, and the next one stops repeating a known
defect.

## Next

Seal Evaluation Epoch 3 independently, then `P1-M.3.4
public_export_reachability_loss` — because `removed_export` is named for
detecting removals and Epoch 2 established that it detects renames instead.
