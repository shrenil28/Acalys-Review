# P1-M.3.4 — frozen

`public_export_reachability_loss`, superseding `removed_export`.

```
contract                 4f1d205   (corrected from 32789dc)
implementation           9b5c6c0
band and witnesses       32808b2   SUPERSEDED
supersession repair      20c0f53   <- freeze
```

The first freeze candidate is superseded and named as such. It passed its own
targeted band and failed the full historical harness, which is the distinction
this checkpoint exists to have learned.

## Evidence

```
pre-run     281 declared · 281 unique · 281 source targets valid ·
            281 declared evidence routes valid · 281 source-changing · 0 invalid
execution   281/281 detected · 280 semantic assertion kills ·
            1 setup kill (#58) · 0 survived · 0 invalid
verify      EXIT=0 · 2,520 tests / 0 skipped · 339 modules / 0 violations
```

Two claims, separated, because a detection count collapses them:

- **M.3.4's own guarantees are defended** — its targeted band killed 12 of 12.
- **The supersession preserved every previously defended guarantee** — which
  is what the full run tests, and what the targeted band structurally cannot.

## What the capability now does

```
OLD   HEAD contains the old name in some changed syntax   ->  maybe a removal
NEW   BASE says X was reachable through boundary B        ->  is X still
                                                              reachable
                                                              through B?
```

Reachability is judged at the declared package entry point. A name reachable
only through an internal module is, to a consumer, gone — the distinction
Epoch 2 exposed and the one a source-shape matcher cannot make.

```
symbol exists somewhere in the repository
        !=
a consumer can import it from the public API
```

## Funnel

```
historical   6/12   same six ids as before the supersession
development   3/8
published FP    0
```

`structural-index-export-declaration-drift`, M.3.1's historical case, is
recovered by the new capability. All six M.3.1 results are re-proved by name
rather than inferred from an unchanged total — an aggregate could hide a lost
true positive behind an unrelated gain.

## What this checkpoint cost, and what it bought

Four defects, none found by writing more tests:

- **TS2724 was missing.** A name dropped from an export list beside its
  siblings produces the suggestion variant, and M.3.1's premise never met it
  because M.3.1 could not reach that shape. `baseline_behaviour_absent`.
- **Boundary resolution skipped the repository root**, collapsing the boundary
  to the declaring module — the exact behaviour this capability exists to stop
  relying on, reintroduced inside the fix for it.
- **The supersession detached historical evidence routes.** Eight survivors
  and four invalids, all from one cause: retiring M.3.1 moved code and tests
  while the manifest kept pointing at where they used to be. Nothing was wrong
  with the shipped product, which is the failure mode.
- **Dead M.3.1 code survived deletion of its registration.** `depcruise`
  reasons about module reachability, and the module stayed reachable through
  M.3.2, so half a file was dead while looking alive.

And one adversarial find worth keeping: `#254` survived retriage because its
fixture put the base and head statements on the same line, so dropping the
wholesale branch produced the right number on the wrong side of the diff.
A line-only assertion was green while the publication was wrong.

## Manifest

281, not 283, and stronger for it. `#252` duplicated `#280` exactly; `#251`
defended a state M.3.4 cannot reach. Preserving identifiers to keep a count
would have been inventory rather than protection.

Preflight now validates the evidence route as well as the target. Its current
check proves the declared suite file exists, which is narrower than the rule
invariant 14 states — a suite can move packages, split, or stop being selected
while the file remains. That gap is recorded rather than papered over.

## Next

Epoch 3 opens once, by the evaluator, under anchor policy 2. The question it
answers is not another test count:

> Does base-surface plus declared-public-boundary reasoning generalize to
> independently authored cases, while staying quiet on within-family
> refutations and unrelated families?
