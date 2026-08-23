# P1-M.4 — frozen

`discarded_replacement_return`, the first capability in the
`returned_value_usage` family. The family is not claimed.

```
contract                 bb797ec
implementation           80e34de
experiment inputs        7da3161
```

## Evidence

```
verify                   EXIT=0 · 2,497 tests / 0 skipped · 338 modules / 0 violations
manifest preflight       268 declared · 268 matched uniquely ·
                         268 change source · 0 invalid before execution
mutation execution       268/268 detected · 267 semantic assertion kills ·
                         1 setup kill (#58) · 0 survived · 0 invalid
mechanism tests          17/17
production witnesses     13/13
natural false positive   replayed, unpublished
```

## Funnel, against the pre-capability baseline

```
                   before M.4      after M.4
historical          5/12            6/12
development          2/8             3/8
published FP           0               0
```

`binding-shadowed-validator-contract`, the rank-3 historical miss, is
recovered. The historical baseline was not recomputed; `5/12` is what the
pre-registered evaluator reported under anchor policy 1, and `6/12` is
measured the same way.

### Per capability

```
                              cand  ver  rej  inc  unavail  prom  pub
historical
  discarded_replacement_return   1    1    0    0        0     1    1
```

## What the mutation work established

Ten targeted mutations, all killed. One survived the first pass and was
classified before anything was touched:

- **`#263` was `test_weakness`.** No witness had a head that both discarded a
  result and kept consuming it elsewhere, so the guard preventing that report
  was never exercised. The witness was added; the guard was not changed.

Three defects were surfaced by guards already in the tree rather than by the
new band:

- `M1_TRACKED_CAPABILITIES` was stale. The neutrality test counted M.4
  findings as non-comparison and correctly reported they differ with and
  without a base. M.4 is a comparison capability and is now tracked, which
  also gives it per-capability metrics.
- Its three reason codes were declared without any verification producing
  them — caught by the reachability guard, as M.3's were.
- The verifier's `getResolvedSignature` needed explicit narrowing; a
  `Signature | undefined` was being passed where a `Signature` was required.

## The distinction this capability turns on

```
normalize(raw): string { return raw.trim(); }    VERIFIED
assertValid(raw): void { ... }                   rejected
isValid(raw): boolean { return raw.length > 0 }  rejected
identity(raw): string { return raw; }            rejected
```

All four discard a result and the analyzer proposes on all four. Only the
first loses anything. The predicate is the case that broke the superseded
contract, where "returns a different value" would have verified precisely what
the prose forbade.

Derivation follows local `const` aliases, so `const result = raw; return
result` is identity while `const normalized = raw.trim(); return normalized`
is a transform. A comparison of the return expression against the parameter
identifier gets both backwards. A mutable rebinding the tracer does not model
is `inconclusive`, never "probably transformed".

## Epoch 2

Still sealed and never observed at the time of this freeze.

```
p1-m-epoch-2/returned-value-usage.v1
bee7cd8e66b788d4664c58578f82ec88b203e760d0f7c78a568ee587728c82c9
```

It is opened once, by the evaluator, under anchor policy 2 — a candidate must
match one enumerated allowed anchor, never the hull. The first observation is
recorded whatever it says, and a failing Epoch 2 is spent rather than tuned
against.
