# P1-M.1 capability-expansion contract

## Decision boundary

P1-L is immutable at `f7b49af1224a0942db6884e2a9939e60b364ac5b`.
Its repository facts remain production infrastructure, but its broad context
treatment is not a demonstrated quality or performance optimization. P1-M may
consume a repository fact only when a specific candidate capability needs that
fact. It must not expand generic prompt context or alter the L.5 evidence.

P1-M.1 changes no analyzer, verifier, planner, publication policy, or production
caller. It freezes the premises that capability work will be judged against.

## Corpus separation

The machine-readable contract is
[`m1-corpus.ts`](../../../apps/review-worker/src/eval/m1-corpus.ts), version
`p1-m1-corpus/2026-08-21.v1`.

```text
historical baseline   12 planted L.5 findings, immutable
development            8 visible cases, one per observed semantic family
holdout                8 sealed cases, one per observed semantic family
natural false positive 1 observed replay, append-only
```

The holdout digest is:

```text
277bad0df521765e5f570adc40c7a65ea9e847317f3e7e991e2f74fe738c7012
```

Development cases are visible while implementing. Holdout fixture structure
and labels were frozen before capability code, but case-level analyzer,
verifier, and publication outcomes must not be inspected while tuning a
capability. The holdout is run only after that capability's implementation,
independent verifier, natural-FP tests, and mutations are frozen. A failed
holdout does not permit editing the same capability against individual holdout
cases; it informs the next independently specified capability checkpoint.

The natural-FP corpus contains only candidates observed from a real analyzer
execution. Constructed clean lookalikes remain useful tests but may not be
renamed or counted as natural false positives. New natural entries are
append-only and require an observation reference plus a replayable candidate.

## Analyzer and verifier independence

Every capability checkpoint records separate derivations:

```text
analyzer   static hypothesis from changed code and demand-selected facts
verifier   independent compiler, checker, execution, or contract procedure
```

The verifier may not call the analyzer or reuse the analyzer's decisive helper.
Sharing authoritative source bytes is allowed; sharing the inference that those
bytes prove is not. A candidate family without an independent verification
procedure is not eligible for publication.

## Per-checkpoint report

Every M.2+ report includes:

```text
DEVELOPMENT
candidate and published precision
candidate and published recall

HOLDOUT
candidate and published precision
candidate and published recall

NATURAL FP
candidates replayed
refuted / inconclusive / unavailable
published false positives

VERIFIER
incorrect rejects
inconclusive
unavailable

ECONOMICS
selected context tokens
latency
additional TP published / additional comments published
```

Undefined ratios remain undefined. They are never rendered as a favorable
zero or one.

## Frozen quality gate

The nine conditions below are **executable**, not prose. They are encoded in
[`m1-gate.ts`](../../../apps/review-worker/src/eval/m1-gate.ts) as
`evaluateM1Gate`, which returns every condition with its observation and the
list of failing ids.

This matters because closure would otherwise be decided by a person reading a
numbered list and comparing it against a report — at exactly the moment that
person most wants to be generous, having just spent several checkpoints
building the thing being judged. Every prior failure in this project happened
there.

Three properties the encoding must keep, each defended by a mutation:

```
undefined is a verdict     0/0 is undefined, never a favourable 1.0
thresholds are inclusive   `>=` proven from both sides at the boundary
inventory before items     exactly nine condition ids, asserted as a set
```

P1-M closes only if one-family-at-a-time checkpoints produce all of the
following against the P1-L baseline:

1. Historical published recall is at least `8/12` (`66.67%`), up from `2/12`.
2. Development published recall is at least `4/8` and holdout published recall
   is at least `4/8`.
3. Published precision is `100%` on historical, development, and holdout sets.
4. No observed natural false positive reaches publication.
5. Existing historical true positives do not regress.
6. Incorrect verifier rejects and verifier unavailability are both zero.
7. Additional true positives divided by additional published comments is `1.0`.
8. Each capability has a production-path witness and semantic mutation kills.
9. Repository context is demand-selected for the claim; broad generic context
   enrichment remains forbidden.

This is a corpus quality gate, not a claim about all repositories. The `8/12`
threshold requires six additional historical true positives and a `4/8`
holdout requires generalization across at least four semantic families. Perfect
scores on the visible development fixtures alone cannot close P1-M.

## Sequence

The first implementation checkpoint is
`configuration_sensitive_type_safety`. It ranks first because two historical
misses have authoritative governing compiler options, deterministic static
semantics, and an independent compiler-diagnostic verification route with low
false-positive risk.

Each subsequent family is selected from the frozen ranking in
[`m1-miss-attribution.md`](./m1-miss-attribution.md). No checkpoint may combine
multiple new analyzer families merely to reach the aggregate gate sooner.
