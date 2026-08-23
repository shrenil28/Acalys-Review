# P1-M.3 — first observation of the sealed holdout

Written once, after M.3 was frozen and its full historical harness was clean.
Recorded before interpretation, and recorded in full because it did not go
well. A holdout that only gets written down when it agrees with you is not a
holdout.

## Provenance

```
M.3 source freeze        d612eac
corrected foundation     048652d   (supersedes the f324630 M.3.0 freeze)
holdout digest           277bad0df521765e5f570adc40c7a65ea9e847317f3e7e991e2f74fe738c7012
verify                   EXIT=0 · 2,437 tests / 0 skipped · 335 modules / 0 violations
mutation run             247/247 detected · 246 semantic · 1 setup (#58) ·
                         0 survived · 0 invalid
```

The digest was recomputed before the first case was read.

## Result

```
planted 8 · published true positives 0 · published FALSE POSITIVES 1
```

| case                                      | family                              | cand | matched | published |
| ----------------------------------------- | ----------------------------------- | ---- | ------- | --------- |
| holdout-api-export-alias-removal          | public_api_compatibility            | 1    | no      | **FP**    |
| holdout-config-indexed-header             | configuration_sensitive_type_safety | 0    | —       | —         |
| holdout-returned-decoded-value-discarded  | returned_value_usage                | 0    | —       | —         |
| holdout-serialization-stable-header-order | deterministic_serialization         | 0    | —       | —         |
| holdout-boundary-quota-limit              | boundary_comparison                 | 0    | —       | —         |
| holdout-failure-observability-lockout     | required_failure_observability      | 0    | —       | —         |
| holdout-sensitive-api-key-log             | sensitive_data_exposure             | 0    | —       | —         |
| holdout-fail-closed-tenant-role           | fail_closed_authorization           | 0    | —       | —         |

This is the first published false positive in the project.

## What the false positive actually is

The case is an aliased export:

```ts
// base                                    // head
export { decode };
export { decode as decodeInternal };
```

M.3.1 identified this correctly. `decode` was public at base, is not public at
head, and a base-shaped consumer importing it no longer compiles. The
capability found the defect the case was planted to catch.

It anchored the finding at **line 1**. The defect is at **line 2**, the export
statement. `removedExportCandidate` hardcodes `startLine: 1, endLine: 1`,
because a removed name has no head declaration to point at and line 1 was
taken as a stand-in. The expectation matcher requires the spans to overlap, so
a correct finding was scored as a false positive.

So the honest classification is `implementation_defect` in the candidate's
location — not a semantic false positive, and not a measurement artifact
either. A reviewer reading this comment would be pointed at the wrong line of
a two-line file.

### What this says about the historical result

`structural-index-export-declaration-drift` — the historical case in the same
family — carries `allowedAnchor: { startLine: 1, endLine: 4 }`. That span
includes line 1, so the same hardcoded anchor overlapped and scored as a true
positive.

The historical `5/12` therefore depended in part on a generous anchor width
rather than on correct anchoring. That is worth stating plainly: the number is
real, the capability does find the defect, and one of its two recoveries would
not have counted against a tighter anchor.

## Gate verdict

```
FAIL  1. historical published recall >= 8/12
      observed 0.4167 (5/12)
FAIL  2. development and holdout published recall each >= 4/8
      observed development 0.25, holdout 0
FAIL  3. published precision 100% on all three splits
      observed historical 1, development 1, holdout 0
PASS  4. no observed natural false positive reaches publication
PASS  5. existing historical true positives do not regress
PASS  6. incorrect verifier rejects and unavailability are zero
FAIL  7. additional true positives / additional published comments == 1.0
      observed 0.75 (3 TP / 4 comments)
PASS  8. every capability has a production-path witness and semantic mutation kills
PASS  9. repository context is demand-selected per capability

P1-M GATE NOT SATISFIED — failing conditions 1, 2, 3, 7
```

Condition 3 failed with a measured `0` this time rather than the `undefined` it
returned after M.2. That is the difference between a split that published
nothing and a split that published something wrong, and the gate distinguishes
them correctly.

Condition 7 failed for the same single reason: four comments published, three
of them true positives.

## What this observation does NOT license

M.3 is frozen and this does not reopen it. Specifically, the anchor defect
must **not** be fixed and the holdout re-run as though the second result were a
sealed observation. The seal is spent. Whatever the anchor fix produces here
afterwards would be a development number wearing a holdout's name, which is
worse than the failure it replaced.

The defect is real and should be fixed. It gets fixed against the development
corpus, validated by its own mutation, and evaluated against the next
independently specified sealed set — not against this one.

## Reading the seven zeroes

Seven of eight holdout cases produced no candidate. Six belong to families
nothing implemented yet covers, and the seventh
(`holdout-config-indexed-header`) is the `noUncheckedIndexedAccess` variant M.2
explicitly placed out of scope.

So the generalization question is still largely unanswered by construction:
only one holdout case falls inside any implemented capability, and that one
found the defect and mislabelled its location. Two capability families out of
eight is not a corpus this holdout can measure generalization across, and
claiming otherwise in either direction would be inventing a result.
