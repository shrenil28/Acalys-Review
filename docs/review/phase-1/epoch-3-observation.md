# Evaluation Epoch 3 — first observation

Opened once by the independent evaluator against frozen M.3.4, under anchor
policy 2. Recorded whatever it says.

## Provenance

```
M.3.4 source freeze      36a7c9c   (HEAD unmoved, tree clean at open time)
Epoch 3 digest           fcaa19119cf9ded0068ce7ce43b033b07f20cb8b3aef3f353333bc4ed4154eb0
seal verified            real process exit 0, before any case was run
status after observation SPENT
```

## Result

```
historical     6 TP / 12   0 FP   precision 1.0    recall 0.5
development    3 TP /  8   0 FP   precision 1.0
Epoch 3        1 TP /  8   1 FP   precision 0.5    recall 0.125
```

The single Epoch 3 true positive is a **cross-family** case published by
`discarded_replacement_return`. The capability this epoch was built to measure
published **zero true positives and the one false positive**.

### Primary family, 4 cases

```
candidates 4 · verified 1 · rejected 2 · inconclusive 1 · unavailable 0 · published 1
```

Two of the four planted defects produced no candidate at all. One was refused
under a frozen exclusion. One published, at the wrong coordinate.

### Within-primary refutations

Four must-decline shapes planted inside the primary cases. The analyzer
proposed on three; **none published**. Two were refused by name with
`public_export_still_reachable`, including both "declaration moved but still
reachable" decoys.

This is the part of the capability that works. The verifier's boundary
reasoning refuted every decoy it was shown.

### Cross-family, 4 cases

Zero reachability candidates raised. No false positive from any of them.
`configuration_sensitive_type_safety` produced nothing on an unchecked index
reached through array destructuring — a second independent confirmation of
Epoch 2's finding that M.2 is write-shaped rather than family-shaped.

## Gate

```
FAIL  1. historical published recall >= 8/12          0.5 (6/12)
FAIL  2. dev and holdout recall each >= 4/8           dev 0.375, holdout 0.125
FAIL  3. published precision 100% on all splits       hist 1, dev 1, holdout 0.5
PASS  4. no natural false positive published
PASS  5. baseline true positives do not regress
PASS  6. incorrect verifier rejects are zero          0 incorrect, 0 unavailable, 1 inconclusive
FAIL  7. additional TP / additional comments == 1.0   0.8333 (5 TP / 6 comments)
PASS  8. witnesses and semantic mutations per capability
PASS  9. context demand-selected per capability

P1-M GATE NOT SATISFIED — failing conditions 1, 2, 3, 7
```

Condition 6 passed with `verifier.rejects = []`, and the evaluator flagged that
it must not be read as the capability performing well. No refutation of an
_expected_ defect occurred because two of the four were never proposed. The
attribution machinery frozen in M.4.1 did its job: it did not manufacture an
accusation, and it did not manufacture a compliment either.

## The false positive, and a defect in the epoch itself

The published finding named the right symbol. `parseDate` genuinely stopped
being reachable. It failed on **side**: M.3.4 anchored the deleted statement
base-side; every anchor in the enumeration is head-side. Under policy 2 it
matches nothing.

The evaluator then reported something it did not have to:

> The sealed head anchor `date.ts:1` points at `function parseDateInternal(...)`
> — a different declaration that merely occupies the deleted one's line. Base
> `date.ts:1` is `export function parseDate(...)`, the coordinate a reader
> actually needs. M.3.4's choice is better than the enumeration that rejected
> it.

The seal (`81a0154`) predates the contract decision that introduced base-side
anchoring (`4f1d205`), so neither side saw the other. The scoring rule was
pre-registered as binding, so **it is applied as written and the result
stands**. The enumeration defect is recorded for a future epoch to fix, exactly
as anchor policy 1's hull defect was preserved rather than retro-corrected.

A rule that only binds when it flatters the implementation is not a rule.

## Diagnosis: where 0/4 came from

The evaluator probed behaviourally with synthetic fixtures after the
observation, never by reading the capability's source. Verified independently
here against the code:

**The analyzer never consults the boundary.** `resolvePublicBoundary` is called
from the verifier and from nowhere else. The analyzer computes a _module's_
export-set delta, and its claim text says `reachable through ${source.path}` —
the declaring module. Two consequences follow:

- **Boundary edits are invisible.** Withdrawing a subpath from an `exports` map
  changes no source file's export set, so nothing proposes. This is the
  sharpest miss: reachability is _defined_ at the boundary, and edits to the
  boundary itself are the one thing the proposer cannot see.
- **The entry point loses to the declaring module.** When one edit loses a name
  at both, only the declaring module's candidate survives. Probes confirm the
  same entry-point loss does fire when declaring modules are untouched, so this
  is cross-file candidate competition rather than a shape the analyzer lacks.

One case was refused under a frozen exclusion — type/value demotion — and the
evaluator cited the clause, so it scores `capability_recall_miss` under its own
pre-registered rule rather than as a broken verifier.

### A correction to the M.3.4 freeze record

`docs/review/phase-1/m34-freeze.md` says boundary resolution "was repaired"
after it collapsed to the declaring module. That is true of the verifier and
false of the analyzer. In the analyzer's proposal and claim text the collapse
survives, and every claim this epoch produced — including the published one —
reads "reachable through <declaring module>".

The freeze evidence stands; the mutations and witnessesmeasure what they measure. The
prose overclaimed the scope of one repair, and the overclaim is corrected here
rather than edited out of the frozen document.

## Evidence this epoch produced for capabilities it was not aimed at

Collapsing this into "1/8, bad" would discard three independent results:

```
M.4    discarded_replacement_return published a TRUE POSITIVE on a case
       authored by someone who had never seen its contract or its
       development corpus. That is generalization evidence, on fresh unseen
       material, for a capability this epoch was not built to test.

M.3.4  every within-primary decoy declined — four planted must-decline
       shapes, three proposed on, none published, with both
       "declaration moved but still reachable" cases refuted by name.
       The verifier's boundary reasoning is sound.

       Zero cross-family hallucinations across four unrelated families.

M.2    produced nothing on an unchecked index reached through array
       destructuring. A second independent confirmation, after Epoch 2's,
       that `exact_optional_property_write` is write-shaped.
```

The M.2 result is not a defect. That capability's name is honest about its
scope, and broadening it because an epoch happened to contain an adjacent
shape is the failure mode the taxonomy exists to prevent. M.3.4 is the
opposite case: its name promised boundary reachability while its proposer
operated on module deltas, and that gap is what earns the next checkpoint.

## What this observation does not license

M.3.4 is frozen and Epoch 3 is spent. Nothing here permits editing the
capability, the fixtures, the gate, or the thresholds against these results.
The analyzer-side boundary gap is real and is the strongest candidate for the
next checkpoint — against a newly sealed Epoch 4, not against these eight
cases, which are now regression evidence only.
