# P1-M.4 — returned_value_usage

Taxonomy rank 3. One historical miss: `binding-shadowed-validator-contract`.

Frozen before implementation, and frozen while Evaluation Epoch 2 is sealed and
unseen. Nothing here is derived from Epoch 2.

## The defect

```ts
// base                          // head
return validate(raw);
validate(raw);
return raw;
```

`validate` returns `raw.trim()`. The base returned the normalized value; the
head returns the untrimmed input and throws the normalization away. The call
still happens, so nothing looks unused — the loss is the _difference_ between
what the callee produced and what the caller now returns.

## What makes this hard, stated before it is convenient to forget

Discarding a return value is not a defect. It is a defect only when the
discarded value carried something the caller now loses. The taxonomy says so
in its own rationale: the capability must distinguish **normalizers** from
**validation-only** calls.

```
validate(raw): string  -> returns raw.trim()   discarding LOSES the trim
assertValid(raw): void -> throws or returns    discarding loses nothing
isValid(raw): boolean  -> used for control     discarding is a different defect
```

A rule keying on "return value unused" would report all three. That is this
family's version of M.2's `UndefinedKeyword` and M.3.2's parameter count: a
cheap proxy that is not the semantics.

## Analyzer — base to head, syntactic, no bindings

The hypothesis, formed from changed syntax and the base revision M.3.0
supplies:

```
BASE  the call's value was used        (returned, assigned, or passed on)
HEAD  the same call is an expression statement, its value discarded
```

Deliberately blind to what the callee does. It may not resolve the binding,
consult the checker, or read the callee's body — those are the verifier's
evidence, and an analyzer that used them would leave the second stage with
nothing to disagree about.

It will therefore propose on validation-only calls. That is expected, and the
refutation is the point.

## Verifier — the exact callee, and what it actually returns

Independent evidence, in this order:

```
1  resolve the EXACT binding of the callee through a revision-backed Program
2  read its declared return type
3  read its return statements
```

Adjudication:

```
return type is void/undefined              -> rejected  (nothing was discarded)
every return returns the argument unchanged -> rejected  (a pure validator)
some return path yields a different value   -> verified  (a normalizer)
the binding cannot be resolved              -> inconclusive
the project cannot be reproduced            -> inconclusive
```

Step 1 is not ceremony. The historical case plants a same-named
`validate(): boolean` in another module precisely so that a verifier resolving
by name rather than by binding reaches the wrong declaration and returns the
wrong verdict. Name matching is forbidden.

Steps 2 and 3 are what make the verifier able to say _no_. A pure validator
whose every `return` hands back its own parameter is refuted on the callee's
own text, not on a guess about intent.

## Anchoring — M.3.3's invariant applies

The published anchor is the changed call statement that discards the value. It
exists in head, is established from syntax, and is not a constant.

```
exact_head    the discarding statement       -> inline eligible
unavailable   no such statement in head      -> withheld and recorded
```

No fallback line. M.3.3's holdout false positive is the standing reminder that
a semantically correct finding at the wrong line is still a broken review.

## Scope

Covers a **direct call whose returned value was used at base and is discarded
at head**. Explicitly out of scope, each a later capability with its own
evidence: unused assignments, discarded promises (`async_value_use` already
owns that), ignored error codes, unused destructured fields, and values
discarded inside a callee rather than at a call site.

## Base states

M.3.0's four, unchanged:

```
present        may compare
absent         the file is new; no base usage existed to lose
unavailable    abstain and record
not_indexed    abstain and record
```

Never "no base, so nothing was discarded".

## Evidence required before freeze

Production witnesses through `runRealAnalysis` covering: the genuine
normalizer discard; a `void` callee refuted; a pure validator refuted; a
same-named decoy in another module resolved correctly; each unestablished base
state; an unreproducible project; and the natural-FP sentinel.

At least one case where the analyzer proposes and the verifier returns
`rejected` — a verifier mutated to always confirm must die.

A separate mutation band, each mutation admitted only after a unique anchor, a
source-changing edit, and a targeted run that executed more than zero tests,
skipped none, and failed on the intended assertion. Survivors classified
before anything is fixed.

Then the full historical mutation harness, because this capability shares
comparison inputs, planning, cache identity, the analyzer registry, verifier
routing and promotion with everything already frozen.

## Measurement

Development corpus only. Epoch 2 stays sealed until this capability's source
is frozen, and is then opened once by the evaluator, not by the implementation
side. A failing Epoch 2 is recorded and spent; it is never tuned against.

Baseline this is measured against:

```
historical   5/12
development   2/8
published FP    0
```
