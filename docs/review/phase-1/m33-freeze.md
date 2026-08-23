# P1-M.3.3 — frozen

Publication-anchor correctness for `removed_export`. No semantic competence
added, and none claimed.

```
M.3.3 source freeze      561334b
repairs                  the published false positive recorded in
                         docs/review/phase-1/m3-observation-1.md
```

## Evidence

```
verify                   EXIT=0 · 2,446 tests / 0 skipped · 335 modules / 0 violations
manifest preflight       253 declared · 253 matched uniquely ·
                         253 change source · 0 invalid before execution
mutation execution       253/253 detected · 251 semantic assertion kills ·
                         2 setup kills (#4, #58) · 0 survived · 0 invalid
```

### On the second setup kill

`#4` was a semantic kill in the previous full run and a setup kill in this
one. Its suite did not start — `executed 0, skipped 14` — which is the
shared-database-name problem `#58` names, not a loss of protection.

Re-run alone it dies semantically: `1 failed | 13 passed (14)`.

Both numbers are reported rather than the flattering one. The batch says 251
semantic kills; `#4`'s protection is real and was verified separately. M.3.3
touches no database code, so nothing here caused the degradation.

## What changed

The anchor is resolved from evidence, in a fixed order:

```
A  the head export statement mentioning the name
B  the head's wholesale re-export, which decides visibility without
   ever writing the name down
C  base-side only            -> not inline-publishable
D  nothing                   -> not inline-publishable
```

No fallback constant. `first-changed-line`, `nearest-declaration` and
`module-start` are each right for the case that motivates them and silently
wrong elsewhere, which is the defect rather than a repair of it.

What cannot be located is withheld from inline publication and recorded as an
abstention. A pure deletion leaves no head coordinate and the publication
surface has no side, so it does not publish.

## Non-interference, measured

```
historical                       5/12   unchanged
development                       2/8   unchanged
per-capability funnel counts            identical to the pre-M.3.3 run
```

Only localization changed, so the next capability starts from a clean quality
surface and any later precision movement is attributable to it.

## Auxiliary diagnostic

Recorded beside the frozen historical number, never replacing it:

```
M.3 semantic recoveries          2
correctly localized recoveries   2   (was 1 before M.3.3)
```

`structural-index-export-declaration-drift` previously counted because its
allowed anchor span happened to include line 1. It now counts because the
anchor is resolved. The frozen `5/12` and the Epoch 1 gate output are
unchanged — editing a pre-registered evaluator's output after seeing results
would be goal-post movement wearing a bug fix's clothes.

## Mutations

Six of seven anchor mutations died, including the literal original bug:

```
250  the published anchor reverts to the hardcoded line 1     KILLED
251  a finding with no established anchor is published anyway KILLED
252  a base-side line is published as a head-side line        KILLED
254  the wholesale re-export is not treated as the boundary   KILLED
255  the internal declaration is used instead of the export   KILLED
256  the anchor's own provenance is dropped                   KILLED
```

`#253` was **withdrawn, not defended**. The `unavailable` state is unreachable
for a removal candidate: a name only becomes one by appearing in the base
export surface, which `exportStatementLine` always finds. The state is kept
because it is the correct model for any future caller reaching the resolver by
another route, and the reason it cannot be mutation-tested is recorded beside
it. Writing a test for behaviour the baseline cannot produce is what invariant
12 forbids.

## Epoch 1 is closed and immutable

M.3.3 repairs the defect Epoch 1 exposed. It does **not** license the claim
that M.3 passed its holdout. It did not:

```
EPOCH 1   source d612eac · historical 5/12 · development 2/8
          holdout 0/8 · holdout published FP 1 · gate FAIL
```

If the old case is ever replayed it is labelled a **post-holdout regression
replay**, never a holdout result, and it earns no generalization credit.

## Next

Pre-register Evaluation Epoch 2 with a fresh independently sealed set —
stratified against the frozen taxonomy so that positive capability coverage
and cross-family false-positive pressure both exist. Epoch 1 had seven of
eight rows guaranteed out of scope, which is why capability-level recall
generalization remains largely unmeasured. Same thresholds, same precision
requirement, same first-observation rule. Then the `returned_value_usage`
contract.
