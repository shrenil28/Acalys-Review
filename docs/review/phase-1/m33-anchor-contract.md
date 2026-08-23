# P1-M.3.3 — removed_export publication-anchor correctness

Deliberately not a capability. M.3.1's semantic reasoning was correct at every
stage that reasons:

```
semantic detection        correct
verification              correct
promotion                 correct
publication localization  WRONG
```

The finding "`decode` was public at base and is not at head" was true. The
publication "look at line 1" was false. For a review product that is still a
correctness failure, and it is the one this checkpoint repairs. M.3.3 earns no
recall credit and adds no semantic competence.

## The invariant

> A verified semantic finding must have independently established publication
> location evidence. Semantic truth does not authorize an invented line anchor.

Which forbids the obvious repair. Replacing `startLine: 1` with a better
constant — first export line, nearest declaration, first changed line, module
start — is the same defect with a longer justification. Each would be right
for the case that motivated it and silently wrong elsewhere, and none of them
is _evidence_ about where the change happened.

## Semantic evidence and publication anchor are different coordinates

A removed name has no head declaration to point at. That is why one field was
made to serve two jobs, and why it broke. They are separated:

```
semantic evidence            publication anchor
  base boundary                side
  base exported name           path
  base export span             line span
  head reachability result     provenance
```

For `removed_export` the evidence lives largely at BASE while the anchor must
come from the diff. They coincide only by accident.

## Anchor resolution, in order

**Case A — the head's changed export syntax establishes the change.**

```ts
// base                      // head
export { decode };
export { decode as decodeInternal };
```

The changed head export declaration is real evidence of where the public
surface moved. Anchor there — line 2 in the case that failed, not line 1.

**Case B — pure deletion, anchorable only on the base side.**

```diff
-export { decode };
```

The head carries no trace. A base-side anchor is the honest coordinate, and
fabricating a head line because publication prefers head is exactly the defect
being repaired. The current publication surface has no side concept, so this
state is **not inline-eligible** and is recorded rather than invented.
Side-anchored publication is separate work with its own evidence.

**Case C — the break is proven and no trustworthy anchor exists.**

```
verified semantic finding + anchor unavailable
```

must never become `publish at line 1`. It withholds inline publication and
records why. This is `truth != attention != publication` again: a true finding
can be unsuitable for an inline comment.

## Anchorability is explicit

```
exact_head      established from changed head syntax   -> inline eligible
exact_base      established from base syntax only      -> not inline eligible
unavailable     no trustworthy coordinate              -> not inline eligible
```

No `fallback`, `best_effort` or `approximate`. A state that means "we guessed"
must not be publishable, and naming it softly is how it becomes publishable.

## Fixtures, generalized rather than copied

The spent holdout case is not used. Development fixtures are derived from the
defect:

1. rename on a non-first line — kills `startLine: 1` directly
2. the same change with the export on line 7 and line 12 — stops `2` becoming
   the next accidental constant
3. pure deletion — base-side state, not a fabricated head line
4. a re-export chain — the anchor follows the public boundary change, not an
   unrelated internal declaration
5. no trustworthy anchor — verified, and not inline-published

## Non-interference

M.3.3 must change publication localization and nothing else:

```
semantic candidates   unchanged
verifier decisions    unchanged
promotions            unchanged
```

Proved directly, not asserted, so that the next capability starts from a clean
quality surface and any later precision change is attributable to it.

## The historical number is not rewritten

`historical = 5/12` stands. It is what the pre-registered evaluator reported,
and editing a frozen gate output after seeing results is goal-post movement
wearing a bug fix's clothes.

An auxiliary diagnostic is recorded alongside it instead:

```
M.3 semantic recoveries         2
correctly localized recoveries  1
```

One recovery counted because its allowed historical anchor span included
line 1.

## The old holdout is spent

Epoch 1's first observation is immutable:

```
holdout recall 0/8 · published FP 1 · precision 0 · gate FAIL
```

M.3.3 repairing this exact defect does not license "M.3 passed holdout". It
did not. If the old case is ever replayed it is labelled a **post-holdout
regression replay**, never a holdout result, and it earns no generalization
credit.
