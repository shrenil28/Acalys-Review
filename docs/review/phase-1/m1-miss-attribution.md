# P1-M.1 miss attribution and capability taxonomy

## Evidence

The authoritative input is the P1-L.5 report at
`f7b49af1224a0942db6884e2a9939e60b364ac5b`. Its machine-readable report digest
is:

```text
da139b3de00250b5a0c8a38b121027078b5197394675a90e2cab8e45b0e0181e
```

Treatment produced candidates for two of twelve planted defects. Both were
verified, promoted, and published. For each of the other ten, the treatment
trace records zero candidates, zero verification attempts, zero promotions,
and zero publication decisions. Every authored repository fact required by
those ten cases was offered, scored, and selected.

Therefore all ten losses occurred at candidate generation. None is a verifier
rejection, verifier abstention, verifier outage, promotion failure, or
publication-policy withholding.

## Funnel attribution

| Historical miss                                  | Semantic family                     | Analyzer | Verifier | Policy  | Required evidence                          | Root cause          |
| ------------------------------------------------ | ----------------------------------- | -------- | -------- | ------- | ------------------------------------------ | ------------------- |
| `config-exact-optional-assignment`               | configuration-sensitive type safety | absent   | not run  | not run | config + structural selected               | analyzer capability |
| `config-unchecked-index-access`                  | configuration-sensitive type safety | absent   | not run  | not run | config + structural selected               | analyzer capability |
| `structural-index-public-signature-declaration`  | public API compatibility            | absent   | not run  | not run | structural selected                        | analyzer capability |
| `structural-index-export-declaration-drift`      | public API compatibility            | absent   | not run  | not run | structural selected                        | analyzer capability |
| `binding-shadowed-validator-contract`            | returned-value usage                | absent   | not run  | not run | binding + structural selected              | analyzer capability |
| `test-relationship-stable-serialization`         | deterministic serialization         | absent   | not run  | not run | test + structural selected                 | analyzer capability |
| `test-relationship-expiry-boundary`              | boundary comparison                 | absent   | not run  | not run | test + structural selected                 | analyzer capability |
| `instruction-auth-denial-audit`                  | required failure observability      | absent   | not run  | not run | instruction + structural selected          | analyzer capability |
| `instruction-payment-token-logging`              | sensitive-data exposure             | absent   | not run  | not run | instruction + structural selected          | analyzer capability |
| `interaction-config-and-instruction-fail-closed` | fail-closed authorization           | absent   | not run  | not run | config + instruction + structural selected | analyzer capability |

The structural-index-only cases mark repository intelligence as supporting
rather than necessary: base and head changed source already carry the public
surface delta. The remaining eight need a non-local contract, governing option,
binding, test, or instruction to establish the claim. In every such case that
fact was available. The failure was not context discovery or planner selection;
the current analyzer set has no procedure for the semantic family.

## Frozen ranking

Scores are ordinal from `1` (low) to `5` (high). For false-positive risk and
cost, lower is better. The ranking is a selection order, not an aggregate score
whose weights can be changed after results arrive.

| Rank | Family                              | Misses | Severity | Detectability | Verification | FP risk | Cost |
| ---: | ----------------------------------- | -----: | -------: | ------------: | -----------: | ------: | ---: |
|    1 | configuration-sensitive type safety |      2 |        4 |             5 |            5 |       1 |    2 |
|    2 | public API compatibility            |      2 |        4 |             4 |            4 |       2 |    3 |
|    3 | returned-value usage                |      1 |        4 |             4 |            4 |       2 |    3 |
|    4 | boundary comparison                 |      1 |        4 |             3 |            4 |       2 |    3 |
|    5 | fail-closed authorization           |      1 |        5 |             3 |            3 |       3 |    3 |
|    6 | sensitive-data exposure             |      1 |        5 |             3 |            3 |       3 |    4 |
|    7 | required failure observability      |      1 |        3 |             2 |            3 |       3 |    4 |
|    8 | deterministic serialization         |      1 |        3 |             2 |            3 |       4 |    4 |

These eight families are induced by the ten observed misses. They are not a
claim that the reviewer supports, or should support, every possible defect
taxonomy. A family may be split later only with new evidence showing that its
members require materially different detection or verification procedures.

## First capability

`configuration_sensitive_type_safety` is the M.2 target. The analyzer must form
a static hypothesis from changed code under its governing TypeScript options.
The verifier must independently obtain the relevant TypeScript diagnostic from
an isolated compiler program. Teaching both stages the same assignment or
indexed-access pattern is forbidden.

No analyzer implementation was added in M.1. The complete attribution,
taxonomy, corpus partitions, and quality gate are frozen before M.2 begins.
