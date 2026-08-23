# P1-M.4 — experiment inputs, fixed before implementation

Everything that could bias the result was frozen before a line of capability
source existed. Recorded here so the causal line is checkable rather than
asserted.

```
EVALUATION RULES

  epoch lifecycle          e215219
  evaluation scorer        2199e9c
    Epoch 1 / historical   policy 1  (hull + overlap, preserved with its defect)
    Epoch 2 onward         policy 2  (enumerated anchors)

HIDDEN DATA

  Epoch 2                  p1-m-epoch-2/returned-value-usage.v1
  composition              8 cases = 4 returned_value_usage + 4 cross-family
  cross-family             configuration_sensitive_type_safety,
                           public_api_compatibility,
                           sensitive_data_exposure,
                           deterministic_serialization
  digest                   bee7cd8e66b788d4664c58578f82ec88b203e760d0f7c78a568ee587728c82c9
  storage                  /home/shrenil/Desktop/acalys-evaluator/epoch-2/
  seal status              SEALED, never observed
  independent verification seal_verifier_exit = 0, SEAL INTACT
  authored by              a separate agent that did not read the M.4 contract

CAPABILITY SEMANTICS

  M.4 contract             bb797ec
  family                   returned_value_usage
  capability               discarded_replacement_return

PRODUCTION SOURCE

  M.4 implementation       NONE at the time of this record
```

## Integration evidence for the scorer seam

`2199e9c` moved `m2-evaluate` onto a shared scorer. A targeted band proves new
behaviour is defended; it does not prove old guarantees survived the move.
The full harness does:

```
preflight     258 declared · 258 matched uniquely · 258 change source · 0 invalid
execution     258/258 detected · 257 semantic assertion kills ·
              1 setup kill (#58) · 0 survived · 0 invalid
verify        EXIT=0 · 2,464 tests / 0 skipped · 336 modules / 0 violations
```

`#4` — which degraded to a setup kill during the M.3.3 run because its
database-backed suite did not start — is a semantic kill again here. Only
`#58` remains, and it is the known shared-database-name case.

## Baseline this capability will be measured against

```
historical    5/12
development    2/8
published FP     0
```

The historical figure is what the pre-registered evaluator reported under
policy 1. It is not recomputed under policy 2.
