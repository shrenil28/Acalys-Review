# P1-M.3.5 — public_boundary_reachability_proposal

```
family      public_api_compatibility
capability  public_export_reachability_loss   (M.3.4, verification unchanged)
repairs     its proposal half
```

Frozen before implementation, while Epoch 4 is sealed and unseen. Nothing here
derives from Epoch 4. Epoch 3 is spent; it established _that_ a gap exists, and
its individual cases are regression evidence only.

## The defect

M.3.4's verifier judges reachability at the declared public boundary. Its
analyzer does not:

```
resolvePublicBoundary   called from the verifier, and from nowhere else
the proposer            computes a MODULE's export-set delta
the claim text          "reachable through <declaring module>"
```

So the boundary repair reached verification and never reached proposal. Two
consequences, both observed:

- **Edits to the boundary are invisible.** Withdrawing a subpath from an
  `exports` map changes no source file's export set, so nothing proposes. A
  capability whose claim is _defined_ at the boundary cannot see changes to the
  boundary.
- **The entry point loses to the declaring module.** When one edit loses a name
  at both, only the declaring module's candidate survives — the same loss fires
  correctly when declaring modules are untouched, so this is candidate
  competition rather than a missing shape.

## The invariant

> If a capability's semantic claim is defined at consumer-visible public
> boundary B, candidate generation must be capable of observing changes to B
> itself.

M.3.4 satisfied that at one stage and not the other, and the name it carries is
the boundary one.

## A boundary surface, not `package.json` matching

Matching manifest syntax would be another proxy — right for the shape that
motivated it, silently wrong for barrels, re-export topology, and entrypoint
moves. The analyzer reasons over a _factual surface_ per revision:

```
PublicBoundarySurface {
  boundaryIdentity      what a consumer imports
  revision              base or head
  consumerEntry         the resolved entry file, when one is declared
  reachableNames        name -> namespace
  provenance            how each name was established
  completeness          established | partial | unavailable
}
```

Proposal becomes one comparison:

```
BASE surface for B exposes X
HEAD surface for B does not
        -> candidate
```

Which covers exports-map withdrawal, barrel narrowing, named-export deletion,
re-export topology change and entrypoint change without five syntax-specific
analyzers.

`completeness` is not decoration. A surface the analyzer could only partly
establish must not license "X is gone" — that is the absence rule M.3.0 froze,
one layer up. Partial or unavailable surfaces abstain and record.

The analyzer still performs no semantic compilation. It needs trustworthy
facts, not a resolver.

## Candidate identity moves to the boundary

The competition failure is an identity failure. Today a candidate is keyed by
declaring module and name; it should be keyed by the thing the consumer lost:

```
repository · base revision · head revision · boundaryIdentity · name · namespace
```

Then one logical break is one candidate, with the several observations that
witness it carried as evidence beneath it:

```
logical candidate   boundary B lost `decode`
evidence            the entry point stopped re-exporting it
                    the declaring module stopped exporting it
                    the manifest withdrew the subpath
```

rather than two candidates racing, where only one of them describes what a
consumer experiences.

Generation order must not decide the outcome. Module evidence discovered first
and entrypoint evidence discovered first must produce the same candidate — a
witness asserts both orders, because this project has been bitten twice by
order-dependent selection (the base/head dedupe collision, and this).

## The verifier is deliberately untouched

Epoch 3's positive result was that boundary reasoning at verification is sound:
every within-primary decoy was declined, both "moved but still reachable" cases
refuted by name. Rewriting it now would change proposal recall and verification
semantics together, and the next epoch could not attribute the difference to
either.

So M.3.5 changes what is proposed and what a candidate is. Verification changes
only where it must accept the boundary identity the candidate now carries,
instead of re-deriving it. The existing verifier regression tests prove this.

## Not being fixed here

The frozen exclusions stand, unchanged and not revisited because an epoch
happened to contain an adjacent shape:

```
default-export changes
namespace re-export shape (`export * as ns`)
type-only versus value-only migration of a name reachable in the other space
changes to a name's type rather than its reachability
```

M.3.5's job is to make proposal speak about the same semantic object the
verifier already adjudicates. It is not to finish TypeScript API compatibility.

## Evidence required before freeze

```
boundary-only edit          the manifest withdraws a subpath, no source file
                            changes -> candidate -> verified -> published.
                            The single most important witness: a mutation
                            returning proposal to module-export deltas must
                            die here

candidate competition       entry point and declaring module both lose the
                            name -> ONE candidate, identified by boundary,
                            with both observations as evidence. Asserted under
                            both generation orders

partial surface             a boundary the analyzer could not fully establish
                            -> abstain and record, never "X is gone"

M.3.4 regressions           every result Epoch 3 showed working still works:
                            each within-primary decoy declined, both
                            moved-but-reachable cases refuted by name
```

Plus production witnesses through `runRealAnalysis`, a separate mutation band
admitted only after targeted execution, survivors classified before anything is
fixed, and the full historical mutation harness — which is what caught the
supersession damage last time and will be run before any freeze claim.

## Measurement

Development corpus only. Epoch 4 is sealed and unseen, opened once by the
evaluator after source freeze, scored under anchor policy 2.

```
baseline   historical 6/12 · development 3/8 · published FP 0
```
