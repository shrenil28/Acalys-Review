# P1-J — deterministic quality and execution baseline

**Status:** COMPLETE. Baseline commit `91f3e8f`, closure evidence at `HEAD`.

The checkpoint that started by asking whether the reviewer is any good, and
spent most of its length discovering that the honest answer needed a different
instrument each time it was asked.

---

## What changed, and what it cost

```
                      analyzer only        through the funnel
J.1 first measurement   precision 1.0        precision 1.0   recall 0.5
J.5 close               precision 1.0        precision 1.0   recall 0.8
```

Recall moved from 0.5 to 0.8 without spending precision, and every point of it
is attributable to one named capability.

| Checkpoint | What it added                              | Recall | Precision |
| ---------- | ------------------------------------------ | -----: | --------: |
| J.1        | the end-to-end funnel, and what it exposed |    0.5 |       1.0 |
| J.2        | false-positive corpus, confusion matrix    |    0.5 |    0.833† |
| J.3.1      | competence gating                          |    0.5 |       1.0 |
| J.3.2      | epistemic independence (async binding)     |    0.5 |       1.0 |
| J.3.3      | signature compatibility                    |    0.6 |       1.0 |
| J.3.4      | condition-value semantics                  |    0.7 |       1.0 |
| J.3.5      | exception flow                             |    0.7 |       1.0 |
| J.3.6      | async callback contract                    |    0.8 |       1.0 |

† J.2 is the only row where precision fell, and it fell because the corpus
gained a false positive the analyzer really produced. That was the point.

---

## The four defects the measurement found

Each was invisible until a number moved, and each was the same mistake wearing
a different coat: **a component confidently answering a question nobody asked
it.**

### 1. The verifier refuted what it could not parse

`observeSite` returned one boolean for three situations — nothing at the line,
a shape it did not model, and a mechanism provably absent — and the caller
turned all three into `rejected` at 0.8 confidence. Four of ten real defects
were suppressed, and recorded as the analyzer being wrong.

> A rejection blames the analyzer. `inconclusive` blames the verifier.
> Getting that backwards sends every future investigation to the wrong
> component.

### 2. Structural independence is not epistemic independence

P1-H stopped the analyzer's context, confidence, reasoning and rule identity
from reaching the verifier. All of it held, and the verifier still confirmed a
false positive — because both resolved callees **by name**.

```
structural independence   inputs are not shared
epistemic independence    the METHOD of settling the fact is not shared
```

Only the second buys anything. A second opinion from a copy of the same
reasoning is not a second opinion.

### 3. The verifier did not know which claims it was competent to judge

A claim that _"retrying `charge()` may double-charge because the provider is
not idempotent"_ came back **rejected** via `guarded_on_all_paths`: the line
was `await charge(100)`, so the promise was handled. It was. The claim was
never about the promise.

### 4. A working capability the router could not reach

The exception capability was correct and every catch claim came back
`ambiguous_claim_target`, because a catch-all registry entry carried the same
patterns. Its own unit tests passed throughout — they called it directly.

---

## What the verifier now does, and refuses to do

Five capabilities, each with a paired safe lookalike, six of seven pairs
discriminating:

```
async_value_use             is this produced value consumed
condition_value_semantics   does this branch test a promise's truthiness
signature_compatibility     does this call still satisfy the contract
exception_flow              does this suppressed failure violate a contract
async_callback_contract     does the receiver drop the callback's promise
```

The refusals matter as much:

- **`items.forEach(async …)` verifies; `await queue.forEach(async …)` is
  refuted.** Same syntax, same method name, separated only by the declared
  contract.
- **A population claim against an exported callable abstains.**
  `findReferences` returning four means four were found, not that four exist.
- **A comment saying "intentionally ignored" refutes nothing.** Otherwise
  anyone silences the reviewer by typing beside the defect.
- **`map` preserving promises refutes only the claim about the receiver.** The
  caller discarding the array is a different claim, and it is true.

Two abstentions remain, both silent catches, and both may be permanent:
best-effort teardown and a forgotten handler are the same code.

---

## Measurement semantics

Four kinds of number, in the type system rather than the prose:

```
measured        counted, including a real 0
notApplicable   no such work occurred
unmeasured      it occurs and we do not account for it
undefinedRatio  the denominator is zero
```

So `model inference cost` is `measured(0)` — no calls, so zero is true.
`infrastructure cost` is `unmeasured`. **`total cost` is therefore unrenderable
as a number**, because an unknown component makes the sum unknown however small
the known part is.

This exists to prevent one specific future sentence:

> before models `$0.00`, after models `$0.14` — it went from free to fourteen
> cents

It never cost `$0.00`. Nobody measured CPU, Docker, Postgres or storage.

---

## The baseline

### A. Quality — one canonical evaluation

```
analyzer precision        1.0
published precision       1.0
published recall          0.8
false positives published   0
incorrect rejections        0
true positives abstained    2   both exception-flow
correlated derivations      0
```

### B. Execution — repeated frozen inputs

| Stage          | Logical | Physical | Ctx tok est |   n | p50 ms | p95 ms | Losses |
| -------------- | ------: | -------: | ----------: | --: | -----: | -----: | -----: |
| analysis       |      18 |       18 |         970 | 360 |   0.30 |   0.46 |      0 |
| verification   |      10 |       10 |         438 | 200 |   0.64 |   1.04 |      2 |
| reconciliation |      18 |       18 |           — | 360 |   0.00 |   0.00 |      0 |
| policy         |      18 |       18 |           — | 360 |   0.00 |   0.01 |      0 |

```
retry amplification              1.0
context tokens / review         1408
  … per published finding        176
  … per clean case                53
deterministically settled         10
deep verification required         0
```

A local deterministic floor on a monotonic clock, not a production prediction:
there is no network and no model in this pipeline.

### C. Inference economics — pre-inference

```
model calls              0
provider tokens          N/A
model inference cost     $0
infrastructure cost      unmeasured
TOTAL cost / review      unmeasured
```

---

## Gates at closure

```
typecheck            0
lint                 clean
format               clean
project references   closed, 9 packages
depcruise            280 modules, 0 violations
schemas              49 files, no drift
clean build          from sources, 0 errors
tests                1,788 executed, 0 skipped, fail-closed
mutations            57/57 killed, 0 survived, 0 invalid
```

---

## What P1-J does not claim

- **Not production economics.** No model call exists, so nothing here predicts
  what a model-backed reviewer costs.
- **Not a claim about real repositories.** A corpus-shaped 1.0 says every
  mistake this corpus knows about is fixed.
- **Not proof that verification is worth its cost.** It has demonstrated
  non-zero independent false-positive filtering on a naturally produced
  analyzer error, and preserves regression cover against it. Whether that
  justifies its price is answerable only once the price exists.

## Carried forward

- Two exception-flow abstentions, frozen deliberately.
- The historical shadowing replay: `inconclusive` where gold says `rejected`.
  Verifier-capability debt; fixing it changes evidence-combination semantics
  and deserves its own checkpoint.
- `P1-VERIFY-CONCURRENCY`: the invocation lease, still recorded and unbuilt.
- One unexplained funnel-suite startup failure after a Docker restart, not
  reproduced in three subsequent runs. Recorded, not dismissed.
