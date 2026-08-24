# P1-M.3.5 + P1-M.3.6 — frozen

Consumer-visible API compatibility, with both halves defended independently.

```
M.3.5   boundary-aware proposal            what left the consumer-visible surface
M.3.6   consumer-boundary verification     does the exact BASE import fail at HEAD
source freeze                              ad0a8ca
```

## Evidence history, preserved rather than tidied

A clean 291-mutant run exists against `65c40da` and **is not the evidence for
this freeze**:

```
65c40da     full run clean — NOT accepted as final evidence
why         source changed afterwards: consumerProbeSource was extracted out
            of verifyConsumerBoundary
detected by the enhanced preflight, which rejected #288's stale anchor
repair      #288 retargeted, its semantic kill re-established alone
final       a fresh 291-mutant run against ad0a8ca
```

The extraction was behaviour-preserving, and that is not the point: the anchor
moved, so the earlier evidence was tied to a tree that no longer exists. It is
recorded here so no future reader mistakes the first clean run for the proof
behind the frozen source.

## Final evidence

```
pre-run     291 declared · 291 unique · 291 source-changing ·
            291 declared suites present · 0 invalid
execution   291/291 detected · 0 survived · 0 invalid
verify      EXIT=0 · 2,567 tests / 0 skipped · 342 modules / 0 violations
```

Split, because a detection count collapses two different claims:

```
NEW  M.3.5/M.3.6      10/10 semantic kills
PRE-EXISTING          278 semantic kills in batch
                      + #7 and #9 verified semantically alone
GENUINE SETUP KILL    #58 only
```

`#7` and `#9` reported `executed 0, skipped 14` and `executed 0, skipped 8` —
their suites never started. Run alone they die semantically at `13 failed / 1
passed` and `2 failed / 6 passed`. This is the fourth occurrence of that
pattern (`#4`, `#8`, now `#7` and `#9`), always to database-backed suites, and
`#58` names the cause. Reported as two numbers rather than the flattering one.

### The regression that did not happen

The dangerous outcome of a shared routing change would be M.3.6's conditional
TS2307 semantics leaking into the module verifier. It did not:

```
#239  M.3.4 recognises TS2307   ->  SEMANTIC_KILL
```

Every module-boundary guarantee held: `#233`/`#234` base validity and snapshot
absence, `#238` TS2693 still refused, `#250`–`#256` anchor resolution,
`#280`–`#287` side, TS2724, root boundary, namespaces, registration, and
duplicate generations.

## What the two capabilities now do

```
proposal        what disappeared from the consumer-visible boundary?
verification    does the exact consumer operation that worked at BASE
                actually stop working at HEAD?
```

Materially different from the M.3.1/M.3.4 lineage, which compared source
shapes. The headline case — a manifest withdrawing a subpath while every source
byte is unchanged — is proposable _and_ provable now, and was neither before.

### The resolver contract, empirical rather than eternal

Measured against the pinned compiler in a layout where the specifier matches a
real file the exports map does not offer:

```
NodeNext   observed to honour the package boundary
Bundler    observed to honour it in the tested construction
Node10     observed to bypass it in the adversarial construction
```

> The invariant is that **consumer verification must exercise
> package-boundary-aware resolution.** `Node10` is the current mutation vehicle
> demonstrating what removing that invariant does — not an architectural
> verdict about resolvers.

An earlier draft of the source comment claimed Bundler also bypassed exports.
Measurement falsified it, and the mutation built on it was `mutation_weakness`
rather than a missing test.

### Why #295 could be retired

```
consumer verifier v1 emits exactly ONE package import per probe
        -> "any probe diagnostic" and "a diagnostic at this specifier"
           are the same set
        -> the mutation separating them is equivalent
```

Conditional, and pinned: `probeImportCount` asserts the cardinality for both
value and type probes, with a two-import premise so it cannot pass by returning
`1` for everything. If a probe ever grows a second import, that test fails and
`#295` must return.

## Funnel

```
historical   6/12
development  3/8
published FP    0
```

Unchanged by these capabilities on the visible corpora, which is expected: the
shapes they add are not present there. Epoch 4 is what measures them.

## Next

Epoch 4 opens once, by the evaluator, under anchor policy 2 with sides
enforced. Nothing here licenses another resolver mode or API shape first.
