# P1-L.3 — incremental invalidation, judged by the full rebuild

**Status: implementation complete, gates green, mutation evidence clean at
`9b2ff77`.**

The claim, stated to match what the code does:

> P1-L.3 establishes an incremental repository-index update path whose
> canonical factual result is equivalent to a fresh H2 rebuild. Incremental
> updates construct a fresh candidate, validate it through the production
> consistency barrier before exposure, preserve H1 on failure, and truthfully
> report invalidation and recomputation work. The current implementation
> selectively reuses reference and binding extraction but still recomputes
> symbols and declarations revision-wide.

Explicitly **not** "only affected repository facts are recomputed".

---

## Two axes, and neither depends on the other

```
INDEX CORRECTNESS            MEASUREMENT CORRECTNESS
full(H2)                     reported work
   == canonical ==              == work actually performed
incremental(H1 -> H2)
```

Statistics are observational. Mutations 122–124 leave the canonical index
byte-identical and fail because the _measurement_ became false — which is
legitimate only because L.3 claims those numbers are true. Metrics never
become load-bearing for correctness.

Demonstrated rather than asserted:

```
                     canonical digest      reported stats
baseline             83d01463…e565         refs 4  bindings 4
#122 module count    83d01463…e565  same   refs 2  bindings 4
#124 hardcoded zero  83d01463…e565  same   refs 4  bindings 0
```

---

## The oracle and the barrier answer different questions

A read-only call-graph trace corrected a claim this codebase was carrying:

```
TEST ONLY                       PRODUCTION
incremental(H1 -> H2)           incremental(H1 -> H2)
       vs                              |
full(H2)                        validateIndexConsistency
canonical equivalence                  |
                                  expose H2
```

`canonicalSerialization` and `indexDigest` are called from **no production
path**. `incremental.ts` had justified leaving its consistency rules
untested on the grounds that "the equivalence oracle would fail first and
more loudly" — true of tests, false of production, where the validator is the
sole barrier before an index is labelled H2.

The trace also found a **constructible** malformed state, not a hypothetical
one: `assemble` recomputes `symbolId` from mapped declarations while the
resolution rides along from H1 untouched, so a carried binding can emerge
`exact` with no symbol. Under a correct plan the mapping holds — which is
exactly why the barrier exists for when it does not.

### The resolution matrix

Derived from what the extractor can emit, not from what the type permits:

```
exact        one symbolId, symbol exists, >=1 declaration,
             every declaration belongs to that symbol
external     no symbolId, no declarations
unresolved   no symbolId, no declarations
ambiguous    no symbolId
```

`ambiguous` earns its line. The record carries a single optional `symbolId`
and cannot express candidates, so an ambiguous binding naming one symbol
would be uncertainty claiming a unique answer — the blurring of multiplicity
and uncertainty L.1 already had to correct once. Nothing produces it today; a
corruption validator should reject states the happy path never creates, or it
is only duplicating the builder.

---

## The asymmetry that decides every judgement call

```
invalidate too much    slower, still equal to a full rebuild
invalidate too little  a stale fact survives, and the index lies
```

Not two sides of one trade-off. The retention rule is visibly
over-conservative: a module is retained only if it was indexed at H1, is
byte-identical, holds no unresolved reference, and binds into nothing that
moved. Content equality alone is the intuitive rule and is wrong, because a
binding is a fact about two modules.

## A revision label is a claim, not a field

```
construct a CANDIDATE
  -> validate
    -> canonicalize
      -> only then is it Index(H2)
```

H1 is never mutated. On failure H1 remains H1 and the caller full-rebuilds.
`attempted` and `succeeded` are separate fields so a fallback can never be
recorded as an incremental win — otherwise the economics question becomes
unanswerable and the answer drifts toward "yes".

## What retention actually saves

```
modules       classified; retained ones skip reference extraction
symbols       recomputed for every module
declarations  recomputed for every module
references    selectively recomputed
bindings      selectively recomputed
```

Symbol identity is formed across the whole revision, so a skipped module's
declarations would be invisible to a binding in one that was not skipped, and
every cross-module reference would degrade to `external`. What retention skips
is one checker query per identifier plus alias resolution.

`referencesRecomputed + referencesRetained == references in the result` is a
true partition today, decided by one set read from both sides. If a later
checkpoint introduces `reused but revalidated` or `partially reconstructed`,
the accounting model changes rather than the states being forced into this
equation to keep it green.

---

## Evidence

**Pre-run validity:**

```
123 declared
123 matched uniquely
123 change source
  0 structurally invalid
```

**Execution:**

```
123/123 mutants detected
  122 semantic assertion kills
    1 setup/startup kill   (#58, the Postgres harness — pre-existing)
    0 survived
    0 invalid
```

Every L.3 mutation is a semantic assertion kill with `executed > 0` and
`skipped 0`:

```
101-111   incremental semantics        exec 10-35
112-121   validator + production barrier exec 19-35
122-124   statistic truthfulness       exec 35
```

`#107` failing 23 of 35 and `#105` failing 9 say those mechanisms are
load-bearing rather than decorative. `#121` — removing the commit barrier from
the production path — is a semantic kill driven through `updateRepositoryIndex`,
not by calling the validator, so it proves `entry -> corruption boundary ->
rejection` rather than "the validator works when somebody calls it".

```
verify      2,009 tests / 0 skipped
depcruise     302 modules / 0 violations
```

### Four defects the mutation suite found, none of them implementation bugs

The gate earned its cost here. Every one was a _proof_ that said more than it
established:

```
a fixture whose fact never changed
  an added ESM module was supposed to make a bare reference resolve. Under
  ESM every file is its own scope, so it stayed unresolved at H2 and no
  mutation could be detected. A global declaration is what actually resolves.

dead defensive code
  a guard against splitting a symbol across retained and recomputed modules,
  defending a hazard the execution model already prevents. Removed rather
  than kept unkillable — dead defensive code reads as protection, so the next
  person adds a case instead of asking whether the hazard exists.

an untested production corruption boundary
  justified by an oracle that runs only in tests.

a vacuous statistics fixture
  the no-change case makes every wrong formula report 0, so swapping one for
  another survived. Replaced with a fixture where the quantities are pairwise
  different, plus the conservation law that makes the number interpretable.
```

Two earlier runs are superseded and recorded as diagnostic only: 110/110 on
the pre-barrier tree, and 120/121 on `acde714` whose single survivor was the
statistics fixture above.

---

## What L.3 does NOT claim

```
minimal invalidation achieved
all repository facts incrementally reused
persistence or cross-run caching
latency improvement
review-quality improvement
```

The carry-forwards from L.1 stand unchanged: unscoped tenant identities are
non-persistable and real tenant scope is required before shared persistence,
and review-quality effect remains unmeasured until L.5.

What L.3 does give L.5 is something concrete to measure: how expensive
checker reference extraction is, how much work retention actually avoids, and
whether revision-wide symbol and declaration rebuilding is material.
