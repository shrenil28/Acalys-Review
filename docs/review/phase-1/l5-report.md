# P1-L.5 quality and economics report

## Decision

**P1-L.5 is complete with no demonstrated review-quality benefit and no
demonstrated incremental wall-clock benefit.** Repository facts remain correct,
but the current analyzers do not consume the additional selected facts in a way
that changes candidate, verification, promotion, or publication outcomes on the
frozen corpus. Do not optimize invalidation width yet.

The canonical machine-readable evidence is
[`l5-report.json`](./l5-report.json). It was produced from source freeze
`76846874f8ceada2d640d760637764ac3744044b` and corpus
`p1-l5-corpus/2026-08-21.v2`.

## Audit

```text
corpus cases                         16
modes per case                        7
per-case mode rows                  112
control/treatment equivalence pairs  96
recorder-audited mode executions    112
invalid/excluded quality runs         0
cache identity pairs                  8
incremental revision pairs            4
incremental measured attempts        80
```

All reported control/treatment pairs passed common-input equivalence. Every
mode passed null-recorder versus real-recorder equality for candidates,
verification decisions and reasons, promotions, publication decisions, and
pre-merge decisions.

Two earlier executions are not evidence and are not represented in the JSON:

1. Freeze `7708e60` stopped before scoring because post-dedup candidates were
   incorrectly used for a pre-competition direct-source attestation.
2. Freeze `68378e6` stopped before scoring because the CLI resolved stale
   package build output.

Both failures were recorded before replacement freezes; neither produced a
report or a retained partial result.

## Quality

| Metric                                           |       Control |     Treatment |
| ------------------------------------------------ | ------------: | ------------: |
| planted findings                                 |            12 |            12 |
| candidates                                       |             2 |             2 |
| candidate TP / FP / FN                           |    2 / 0 / 10 |    2 / 0 / 10 |
| candidate precision                              |          100% |          100% |
| verified / rejected / inconclusive / unavailable | 2 / 0 / 0 / 0 | 2 / 0 / 0 / 0 |
| promoted                                         |             2 |             2 |
| published / withheld                             |         2 / 0 |         2 / 0 |
| published TP / FP / FN                           |    2 / 0 / 10 |    2 / 0 / 10 |
| published precision                              |          100% |          100% |
| published recall                                 |        16.67% |        16.67% |

```text
TP recovered because repository context existed   0
FP introduced because repository context misled   0
```

No leave-one-family-out ablation changed an outcome. Every quality opportunity
is therefore attributed to `none`; no family can claim recovery, and no family
introduced a published false positive.

### Per-case outcomes

| Case                                           | Control candidates/published | Treatment candidates/published |
| ---------------------------------------------- | ---------------------------: | -----------------------------: |
| structural-index-public-signature-declaration  |                        0 / 0 |                          0 / 0 |
| structural-index-export-declaration-drift      |                        0 / 0 |                          0 / 0 |
| binding-floating-reservation                   |                        1 / 1 |                          1 / 1 |
| binding-shadowed-validator-contract            |                        0 / 0 |                          0 / 0 |
| test-relationship-stable-serialization         |                        0 / 0 |                          0 / 0 |
| test-relationship-expiry-boundary              |                        0 / 0 |                          0 / 0 |
| config-exact-optional-assignment               |                        0 / 0 |                          0 / 0 |
| config-unchecked-index-access                  |                        0 / 0 |                          0 / 0 |
| instruction-auth-denial-audit                  |                        0 / 0 |                          0 / 0 |
| instruction-payment-token-logging              |                        0 / 0 |                          0 / 0 |
| interaction-binding-and-test-delivery          |                        1 / 1 |                          1 / 1 |
| interaction-config-and-instruction-fail-closed |                        0 / 0 |                          0 / 0 |
| clean-shadowed-async-name                      |                        0 / 0 |                          0 / 0 |
| clean-unrelated-nearby-test                    |                        0 / 0 |                          0 / 0 |
| clean-non-governing-strict-config              |                        0 / 0 |                          0 / 0 |
| clean-sibling-instruction-scope                |                        0 / 0 |                          0 / 0 |

## Context

| Metric                      | Control | Treatment |   Change |
| --------------------------- | ------: | --------: | -------: |
| offered items               |      42 |        67 |   +59.5% |
| offered estimated tokens    |   1,000 |     1,579 |   +57.9% |
| scored items                |      40 |        49 |   +22.5% |
| selected items              |      40 |        49 |   +22.5% |
| selected estimated tokens   |     796 |     1,036 |   +30.2% |
| median selected tokens/case |      43 |        67 |   +55.8% |
| max selected tokens/case    |      96 |       154 |   +60.4% |
| useful estimated tokens     |     187 |       236 |   +26.2% |
| irrelevant estimated tokens |      22 |        26 |   +18.2% |
| unlabelled estimated tokens |     582 |       765 |   +31.4% |
| context efficiency          |  23.49% |    22.78% | -0.71 pp |
| duplicates suppressed       |       2 |        18 |      +16 |

Treatment's median context remains below the frozen `2x` escalation ceiling,
but the added context did not improve quality and slightly reduced useful
context per selected token. The appropriate follow-up is narrower planner
consumption or analyzers that can use these facts, not more factual indexing.

## Cache Identity

```text
true cache reuse                 2 / 2
correct invalidation             6 / 6
unnecessary invalidation         0
dangerous false reuse            0
```

Both config-only pairs, both instruction-only pairs, and both
context-selection-only pairs invalidated correctly. Both unchanged-input pairs
reused the production analyzer key. The hard correctness stop condition passes.

## Incremental Economics

All four incremental indexes were canonically equivalent to full rebuilds.
Every one of the 80 measured updates succeeded incrementally with no fallback,
but the aggregate median paired speedup was `0.894x` (`full / incremental`),
below both parity and the frozen `1.111x` threshold.

| Pair                                | Success | Median full ms | Median incremental ms | Median paired speedup |
| ----------------------------------- | ------: | -------------: | --------------------: | --------------------: |
| incremental-binding-caller-edit     |   20/20 |          0.369 |                 0.413 |                0.903x |
| incremental-test-contract-edit      |   20/20 |          0.378 |                 0.421 |                0.905x |
| incremental-config-source-edit      |   20/20 |          0.159 |                 0.176 |                0.904x |
| incremental-instruction-source-edit |   20/20 |          0.178 |                 0.206 |                0.865x |

Across repeated observations, 20 of 180 module records were retained, while no
reference or binding records were retained. The measured fixtures are small,
and incremental planning overhead exceeds the work it avoids. Do not optimize
invalidation width yet.

## Stop Conditions

|  ID | Verdict                 | Conclusion                                              |
| --: | ----------------------- | ------------------------------------------------------- |
|   1 | pass                    | dangerous false cache reuse is zero                     |
|   2 | pass                    | recorder non-interference holds                         |
|   3 | pass                    | equivalence identities hold                             |
|   4 | pass                    | published precision did not drop                        |
|   5 | no demonstrated benefit | recall did not rise and precision is unchanged          |
|   6 | pass                    | median selected-token cost stayed within `2x`           |
|   7 | pass                    | no family introduced more FP than TP recovered          |
|   8 | investigate             | incremental economics missed the frozen speed threshold |
|   9 | no demonstrated benefit | no aggregate quality count changed                      |
|  10 | pass                    | no post-result production optimization was made         |

## Closure

L.1-L.4 remain factual capabilities. L.5 does **not** establish that their
current planner consumption improves review output. The board closes L.5 as a
completed negative measurement, with these follow-up constraints:

1. Retain the factual indexes and their correctness contracts.
2. Do not claim review-quality improvement from repository intelligence yet.
3. Narrow or redesign consumption before adding more context families.
4. Do not optimize incremental invalidation width on these economics.
5. Preserve the cache-identity behavior, especially zero dangerous false reuse.
