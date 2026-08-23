# Evaluation Epoch 2 — first observation

Opened once by the independent evaluator, against the frozen M.4 source, under
anchor policy 2. Recorded whatever it says.

## Provenance

```
M.4 source freeze        6cc0665   (tree clean, HEAD unmoved at open time)
Epoch 2 digest           bee7cd8e66b788d4664c58578f82ec88b203e760d0f7c78a568ee587728c82c9
seal verified            exit 0, before any case was read
scoring                  policy 2 — one enumerated anchor, never the hull
status after observation SPENT
```

## Result

```
historical     6 TP / 12   0 FP   precision 1.0   recall 0.5
development    3 TP /  8   0 FP
Epoch 2        0 TP /  8   0 FP   recall 0        precision UNDEFINED
```

Precision is `undefined`, not `1.0`. Nothing was published, and a split that
published nothing has not demonstrated precision. No published finding landed
at a non-enumerated anchor, so policy 2 never had to reject one — the
machinery frozen at `2199e9c` was not exercised in anger, which is worth
saying rather than counting as a pass.

## Gate

```
FAIL  1. historical published recall >= 8/12          0.5 (6/12)
FAIL  2. dev and holdout recall each >= 4/8           dev 0.375, holdout 0
FAIL  3. published precision 100% on all splits       hist 1, dev 1, holdout undefined
PASS  4. no natural false positive published          0 of 1 replayed
PASS  5. baseline true positives do not regress
FAIL  6. incorrect verifier rejects are zero          1 incorrect reject
PASS  7. additional TP / additional comments == 1.0   1 (4 TP / 4 comments)
PASS  8. witnesses and semantic mutations per capability
PASS  9. context demand-selected per capability

P1-M GATE NOT SATISFIED — failing conditions 1, 2, 3, 6
```

## Per case

| case                                           | family                              | cand | decision | published | stopped at   |
| ---------------------------------------------- | ----------------------------------- | ---- | -------- | --------- | ------------ |
| e2-returned-settings-defaults-discarded        | returned_value_usage                | 1    | rejected | no        | verifier     |
| e2-returned-awaited-canonical-region-discarded | returned_value_usage                | 0    | —        | no        | analyzer     |
| e2-returned-collapsed-text-not-reaching-sink   | returned_value_usage                | 0    | —        | no        | analyzer     |
| e2-returned-normalized-rows-not-returned       | returned_value_usage                | 0    | —        | no        | analyzer     |
| e2-api-barrel-narrowed-public-surface          | public_api_compatibility            | 0    | —        | no        | analyzer     |
| e2-config-exact-optional-spread-nickname       | configuration_sensitive_type_safety | 0    | —        | no        | analyzer     |
| e2-sensitive-card-token-debug-log              | sensitive_data_exposure             | 0    | —        | no        | out of scope |
| e2-serialization-cache-key-order-unpinned      | deterministic_serialization         | 0    | —        | no        | out of scope |

## The one candidate, and a correction to its diagnosis

The single candidate was correct in every respect the funnel controls: right
rule, right line, an enumerated anchor, and a claim accurately stating that
the base consumed the result and the head discards it. The verifier refuted it.

The evaluator attributed this to derivation — that a replacement is recognised
only when the returned value is a call or member chain rooted at a parameter,
and that wrapping it in an object literal or `new C(...)` loses it.

That is not the mechanism. Probed directly against synthetic fixtures:

```
return raw.trim();                     verified
return { value: raw.trim() };          rejected — { value: string } cannot replace string
return new Box(raw.trim());            rejected — Box cannot replace string
return [raw.trim()].join('');          verified
```

The last line disproves the derivation account: it is neither a chain rooted
at `raw` nor a member access on it, and it verifies. The rejection happens one
step earlier, at `isTypeAssignableTo(returnType, parameterType)`. Derivation
never runs.

**And that rejection is what the frozen contract requires.** `bb797ec` says the
returned value must be _type-compatible with replacing that input_. A wrapper
type is not a replacement for the parameter it wraps. The verifier did what it
was specified to do.

## So what the 0/8 actually measures

Two different things, and conflating them would misdirect the next checkpoint.

**A scope boundary, not a defect.** Epoch 2's rank-3 cases were authored from
the _family_ semantics — the evaluator deliberately never read the M.4
contract, and said so in advance: "if that contract scopes some shape here out,
the fixtures do not move to accommodate it." M.4 implements one shape of the
family, `discarded_replacement_return`. The settings case is a family-level
true positive that falls outside the implemented capability. Condition 6's
"incorrect verifier reject" is really "one case outside the capability's frozen
scope, labelled a true positive by an epoch that measures the family".

**Genuine gaps, each a real recall limit:**

```
await hides the discard       `await f(x); return x;` is an await-expression
                              statement, not a call-expression statement, and
                              the proposer does not look through it

bound then abandoned          `const prepared = f(rows); ... return rows;`
                              computes the replacement and drops it, which is
                              a shape the capability does not model

M.2 is write-shaped           an exactOptionalPropertyTypes violation in an
                              object-literal spread produces nothing; the same
                              option with a property write fires

M.3.1 is rename-shaped        an alias rename fires and publishes correctly,
                              but a name simply dropped from an export list
                              produces nothing in every variant probed
```

The M.3.1 finding is the sharpest portfolio result. The capability was built
against the historical alias-rename case and generalizes to renames, not to
removals — which is what `removed_export` is named for.

## The clearly positive result

No capability hallucinated a `returned_value_usage` finding on any of the four
cross-family cases, and the natural false positive stayed unpublished. Epoch 2
was built to apply precision pressure that Epoch 1 could not, and the portfolio
held. Epoch 1's published false positive has not recurred.

## Epoch 2 is spent

Recorded immutably by the evaluator at
`/home/shrenil/Desktop/acalys-evaluator/epoch-2/epoch-2-observation.md`, seal
still verifying, fixtures untouched. Any replay of these eight cases is a
post-holdout regression replay and earns no generalization credit. Nothing here
licenses editing M.4, M.3 or M.2 against these results.

## Measurement notes the evaluator raised

The historical 12 were driven by the evaluator's own adaptation, because no
committed harness runs them with a base revision — `runL5ProductionFunnel`
pins base revision off in every mode by design, as the instrument that measured
the frozen P1-L baseline. It reproduced `6/12` with the same recovered cases,
which is independent corroboration of a number this side computed separately.

Condition 7's formula is supplied by the caller rather than defined in the
repository. The evaluator used the one that reproduces Epoch 1's recorded
`0.75 (3 TP / 4 comments)` exactly. That is a gap worth closing before it
decides anything: a gate input with no frozen formula is a gate input that can
be chosen after seeing the result.
