# P1-M.3 — frozen

Two capabilities, measured independently, on a corrected comparison-revision
foundation.

## Provenance, including what was superseded

The original M.3.0 freeze does not stand on its own. Implementing M.3 produced
executable evidence of a correctness defect inside it, so the foundation this
checkpoint rests on is not the one that was frozen at `f324630`.

```
original M.3.0 freeze     f324630
superseded because        base and head context items are both spanless, so
                          they collided on the `path|startLine|endLine`
                          dedupe identity; base was generated first, claimed
                          the key, and the changed file's own full text was
                          discarded silently, for every analyzer, with no
                          omission recorded
corrected foundation      048652d
M.3 source freeze         c7700d1
```

Reporting M.3 as "built on the frozen M.3.0" would be false. It is built on a
corrected M.3.0, and the full historical harness below is what re-establishes
the freeze rather than the earlier run.

## Evidence

```
verify                    EXIT=0 · 2,437 tests / 0 skipped
dependency graph          335 modules / 0 violations
manifest preflight        247 declared · 247 matched uniquely ·
                          247 change source · 0 invalid before execution
mutation execution        247/247 detected · 246 semantic assertion kills ·
                          1 setup kill (#58) · 0 survived · 0 invalid
holdout digest            277bad0df521765e5f570adc40c7a65ea9e847317f3e7e991e2f74fe738c7012
holdout state             SEALED — not opened during implementation
```

Pre-run validity and execution are reported separately, and `#58` stays
outside the semantic count.

## Measured funnel, against the pre-capability baseline

```
                     before M.3      after M.3
historical            3/12            5/12
development            1/8             2/8
published FP             0               0
```

The historical baseline was not recomputed with today's analyzer set. `3/12`
is the number M.3.0 left in place, and `5/12` is measured against the same
frozen corpus.

Both cases the taxonomy assigned to this family were recovered:

```
structural-index-public-signature-declaration   M.3.2
structural-index-export-declaration-drift       M.3.1
```

Both baseline true positives survived, and precision stayed at 100%.

### Per capability

```
                              cand  ver  rej  inc  unavail  prom  pub
historical
  removed_export                 1    1    0    0        0     1    1
  required_parameter_added       1    1    0    0        0     1    1
development
  required_parameter_added       1    1    0    0        0     1    1
```

Recorded per capability so that a number which fails to move can be attributed
— analyzer never proposed, verifier refuted, evidence unavailable, publication
withheld — without a fresh investigation each time.

## What the mutation work actually established

Three passes. The first killed 13 of 20, and only two of the seven survivors
were missing tests. The rest were classified and handled as what they were:

- **`#242` was an implementation defect.** Degradations were computed for
  `unavailable` and `not_indexed` bases and then discarded three times over —
  by both analyzers, by `runAnalysis`, and by a `DegradationReason` union with
  no member for an analyzer that ran correctly and declined to answer. The
  abstention was silent end to end, so a review that could not establish its
  inputs was byte-identical to a review that found nothing. Analyzer
  abstentions now reach the report under `analyzer_abstained`.
- **`#235` was an equivalent mutant and was deleted.** The probe-locality
  filter cannot be exercised, because `getSemanticDiagnostics(source)` is
  already scoped by TypeScript. Writing a test for it would have been
  elaborate protection for behaviour the baseline never had to supply.
- **`#241` could not create the difference it claimed.** An empty base yields
  fewer removal candidates, never more. Retargeted at the `absent` path, where
  reporting a new file as an abstention is observably wrong.
- **`#243` removed one of two mutually redundant guards.** They are one guard;
  the mutation now removes both.
- **`#246` and `#247`** needed fixtures with overloads and optional parameters
  _at base_. Neither is observable through a verdict — optional parameters
  absorb extra arguments — so both are pinned through the claim's stated
  arity, which is user-visible output.

## Measurement plumbing is not treatment

The harness now supplies a comparison revision for every case. That is a
change to the instrument, so it is proved inert rather than argued to be:
all eight development cases produce byte-identical non-comparison findings
with and without a base, while the cache key correctly differs — because the
inputs genuinely differ even though the older analyzers see the same thing.

## Scope held

`removed_export` covers reachability through a consumer-visible boundary.
`required_parameter_added` covers positional required arity on exported
callables. Neither was widened during implementation. Return-type variance,
parameter-type variance, generic constraints, `this` parameters, constructors
and override compatibility remain separate propositions with their own
evidence.

TS2307 and TS2693 remain unrecognised, and the reasons are narrow rather than
general: TS2307 because an absent boundary is observationally identical to an
incomplete snapshot, and TS2693 because it is produced by our own choice of
probe rather than by the author's change.

## Next

Open the sealed holdout once, record the first observation immutably whatever
it says, remeasure the whole funnel, and let `evaluateM1Gate` decide whether
another capability is needed. A holdout result is not permission to edit M.3.
