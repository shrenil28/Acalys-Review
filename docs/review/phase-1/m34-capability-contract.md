# P1-M.3.4 — public_export_reachability_loss

```
family      public_api_compatibility
capability  public_export_reachability_loss
supersedes  M.3.1 removed_export
```

Frozen before implementation, and frozen while Evaluation Epoch 3 is being
sealed and remains unseen. Nothing here derives from Epoch 3, and Epoch 2 is
spent — its per-case detail informed _that a gap exists_, never what the
fixtures should be.

## Why this supersedes rather than extends

`removed_export` is named for detecting removals. Epoch 2 established that it
detects **renames**:

```
export { decode }  ->  export { decode as decodeInternal }   detected
export { decode }  ->  (decode simply gone)                  NOT detected
```

The cause is structural. Its analyzer compares the _syntactic export names_ of
base and head, and its anchor resolution requires a head statement mentioning
the name — so a name that leaves without a trace leaves no anchor and no
candidate. That is not a bug inside `removed_export`; it is the shape of the
rule. A capability whose name promises removals and delivers renames is an
honesty defect, and the repair is a capability that means what it says.

So M.3.1's rule id is **retired** in the same change that introduces this one.
Two capabilities both firing on a rename would double-report one logical break
and make deduplication a rule to remember rather than a structural fact.

The obligation that comes with superseding: `structural-index-export-
declaration-drift`, the historical case M.3.1 recovers, must still publish. A
rename is a reachability loss for the old name, so subsumption covers it — but
condition 5 is what proves it, not this paragraph.

## The claim

> A name reachable through consumer-visible public boundary B at BASE is no
> longer reachable through B at HEAD.

Reachability, not the survival of a declaration and not the presence of a
name in a head statement.

## Analyzer

Reasons from the base surface forward, and **must not require the old name to
appear anywhere in head** — that requirement is precisely the current failure.

```
BASE   boundary B exposes X
HEAD   the changed public surface may no longer expose X
```

It may over-propose when syntax cannot settle a re-export, and it should: an
`export *`, a barrel, or a moved declaration are all cases where a single-file
syntactic pass genuinely cannot know. The verifier decides actual reachability.

It may not resolve modules, consult the checker, or read another file's
exports.

## Verifier

The M.3 principle, unchanged, with one addition that Epoch 2 made necessary:

```
synthesize a consumer that uses X through boundary B
        ↓
compile against BASE          ← MANDATORY PREMISE
        ↓
BASE must accept it
        ↓
compile the same consumer against HEAD
        ↓
HEAD accepts        -> rejected
HEAD loses X        -> verified
cannot reconstruct  -> inconclusive
verifier cannot run -> unavailable
```

**Resolve from the declared public entry point.** Epoch 2 probing found the
existing verifier treating a symbol as reachable because _some_ internal module
still exported it, even where the package boundary had stopped exposing it.
Consumers import the entry point; a name still reachable only through an
internal path is not reachable to them. Where a package declares an entry
point, that is boundary B. Where none is declared, the module path the base
consumer used is B.

Recognised diagnostics stay as M.3.1 established them empirically — TS2459,
TS2460, TS2305 — and TS2307 and TS2693 stay excluded, for the reasons already
recorded: an absent boundary is indistinguishable from an incomplete snapshot,
and a value probe against a type-only export produces a fact about the probe.

## Anchoring

M.3.3's invariant applies and is the harder half of this capability. A name
that simply disappeared has **no head statement to point at**, which is exactly
why M.3.1's anchor resolution refused to produce one.

```
exact_head    a head statement decides the name's visibility
exact_base    only the base statement locates it   -> not inline eligible
unavailable   no trustworthy coordinate            -> not inline eligible
```

A genuine removal will frequently land in the second or third state. That is a
correct outcome, not a failure: a verified break with no publishable anchor is
withheld and recorded, never anchored at a fabricated line. Publishing removals
inline needs base-side anchoring, which the publication surface does not have
and which is separate work with its own evidence.

Recording this now because it is the predictable disappointment of this
checkpoint: recall may improve at the verifier while inline publication does
not, and the honest response is to report both numbers rather than to invent a
line.

## Scope

Covers reachability of a **named export** through a boundary. Out of scope,
each needing its own evidence: default-export changes, namespace re-export
shape (`export * as ns`), type-only versus value-only migration of a name that
remains reachable in the other space, and changes to a name's _type_ rather
than its reachability.

## Base states

M.3.0's four, unchanged. `absent` positively establishes that the file is new
and nothing it declares can have been removed. `unavailable` and `not_indexed`
abstain and record.

## Evidence required before freeze

Development fixtures authored from this contract, not from Epoch 2:

```
a name genuinely gone                          -> verified
a declaration moved, re-exported by name       -> rejected
a declaration moved behind `export *`          -> proposed, then rejected
reachable only through an internal module      -> verified at the entry point
a type-only export still type-reachable        -> not fabricated through value space
base unavailable / not_indexed                 -> no invented removal
a rename                                       -> still detected, M.3.1's case preserved
```

Production witnesses through `runRealAnalysis`, at least one analyzer-proposes
/ verifier-rejects pair, a separate mutation band admitted only after targeted
execution, survivors classified before anything is fixed, then the full
historical mutation harness.

## Measurement

Development corpus only. Epoch 3 is sealed and unseen; it is opened once, by
the evaluator, after this capability's source freeze, and scored under anchor
policy 2. A failing Epoch 3 is recorded and spent, never tuned against.

```
baseline   historical 6/12 · development 3/8 · published FP 0
```
