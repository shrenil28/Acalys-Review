# P1-M.2 — first observation of the sealed holdout

Written once, after the capability was frozen and its mutation run was clean.
Recorded before any interpretation, because the value of a sealed holdout is
entirely in the fact that it is looked at once, deliberately, with the result
written down whatever it says.

## Provenance

```
capability source freeze : 36a7e27
documentation state      : 30228b1
holdout digest           : 277bad0df521765e5f570adc40c7a65ea9e847317f3e7e991e2f74fe738c7012
verify                   : 2,319 tests / 0 skipped, 329 modules / 0 violations
mutation run             : 216 loaded, 216 unique, 216 uniquely applicable,
                           0 structurally invalid
                           216/216 detected, 215 semantic kills,
                           1 setup kill (#58), 0 survived, 0 invalid
```

The digest was recomputed before the first case was read. A holdout whose seal
is checked afterwards is a holdout that was already opened.

## Measured funnel

Every number below is the count of findings that survived all four stages —
`runRealAnalysis` -> `verifyDeterministically` -> `promoteVerified` ->
`planPublication`. Candidate counts are not reported as results; they measure
the analyzer, and the gate is about what a reviewer would actually see.

| split       | planted | published TP | published FP |
| ----------- | ------- | ------------ | ------------ |
| historical  | 12      | 3            | 0            |
| development | 8       | 1            | 0            |
| holdout     | 8       | 0            | 0            |

### Historical twelve, case by case

```
PUB  binding-floating-reservation            baseline true positive, preserved
PUB  interaction-binding-and-test-delivery   baseline true positive, preserved
PUB  config-exact-optional-assignment        RECOVERED by M.2
     config-unchecked-index-access           still missed — noUncheckedIndexedAccess
     structural-index-public-signature-declaration
     structural-index-export-declaration-drift
     binding-shadowed-validator-contract
     test-relationship-stable-serialization
     test-relationship-expiry-boundary
     instruction-auth-denial-audit
     instruction-payment-token-logging
     interaction-config-and-instruction-fail-closed
```

Historical published recall moved `2/12` -> `3/12`. That is the whole of what
M.2 was capable of moving: the family owns two historical misses, and the
second (`config-unchecked-index-access`) is the `noUncheckedIndexedAccess`
variant the capability contract explicitly placed out of scope. The bound was
stated before the measurement, and the measurement matched it.

### Holdout

All eight cases produced zero candidates. Seven belong to families M.2 does
not implement. The eighth, `holdout-config-indexed-header`, is
configuration-sensitive but is the indexed-access variant — the same exclusion
that leaves `config-unchecked-index-access` missed above.

This is the honest reading: M.2 generalized to nothing in the holdout, because
the holdout contains no in-scope instance of M.2's family. That is a fact about
corpus composition, not evidence either for or against generalization. A
capability whose holdout instances are all out of scope has not been tested for
generalization at all, and claiming otherwise in either direction would be
inventing a result.

## Gate verdict

```
FAIL  1. historical published recall >= 8/12
      observed: 0.25 (3/12)
FAIL  2. development and holdout published recall each >= 4/8
      observed: development 0.125, holdout 0
FAIL  3. published precision 100% on all three splits
      observed: historical 1, development 1,
                holdout undefined (nothing was published in this split)
PASS  4. no observed natural false positive reaches publication
PASS  5. existing historical true positives do not regress
PASS  6. incorrect verifier rejects and unavailability are zero
PASS  7. additional true positives / additional published comments == 1.0
PASS  8. every capability has a production-path witness and semantic mutation kills
PASS  9. repository context is demand-selected per capability

P1-M GATE NOT SATISFIED — failing conditions: 1, 2, 3
```

Condition 3 deserves a note, because it is the one that looks like a bug and is
not. Holdout precision is `undefined`, not `1.0`. Nothing was published in that
split, and `0/0` is not a perfect score — it is the absence of a score. The
gate reads an undefined ratio as failing rather than passing, so a capability
set cannot earn a precision condition by publishing nothing at all. It will
resolve to a real number as soon as some capability publishes there.

Conditions 1 and 2 fail because one capability of eight is implemented. They
are expected to fail until enough of the taxonomy is built, and reporting them
as anything other than `FAIL` at this point would be the vanity-metric failure
the checkpoint exists to prevent.

## What this observation is not permitted to change

M.2 is frozen. This measurement does not reopen it. Specifically, the fact that
`holdout-config-indexed-header` produced nothing is **not** a reason to widen
M.2 to cover `noUncheckedIndexedAccess` — tuning a capability against a holdout
result is exactly what the seal exists to prevent, and doing it would convert
the holdout into a second development corpus permanently.

The indexed-access variant is a separate capability. It gets built, if it gets
built, on its own evidence and against the development corpus.
