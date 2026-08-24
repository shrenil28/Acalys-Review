# P1-M.3.6 — public_boundary_consumer_verification

```
family      public_api_compatibility
capability  public_boundary_consumer_verification
pairs with  M.3.5 (proposal), which is unchanged
```

Frozen before implementation. Epoch 4 is sealed and was never observed; nothing
in it caused this capability to exist.

## Why this exists

M.3.5 proposes boundary losses correctly, including the one M.3.4 could not see
at all: a manifest withdrawing a subpath while every source file is untouched.
The existing verifier cannot adjudicate it, and the reason is structural rather
than a defect:

```
its probe          import { decode } from "./codec";
that asks          can another source file still reach codec.ts?
it does not ask    can an external consumer still import pkg/codec?
```

`src/codec.ts` is byte-identical at head and still exports `decode`, so the
probe compiles and the verifier reports "still reachable" about a boundary that
no longer exists.

### The correction this contract records

M.3.5 currently returns `inconclusive` for a withdrawn boundary, on the ground
that it cannot be probed. That is **transitional, and semantically backwards**
as a terminal rule:

> A withdrawn public boundary is not evidence unavailability. It is the
> hypothesis.

Once this capability exists, only a genuinely unreconstructable package
environment stays inconclusive.

## The question

> Given a public consumer specifier that was valid at BASE, does the exact same
> consumer usage remain valid at HEAD?

```
synthetic external consumer     import { decode } from "pkg/codec";
                                void decode;
        │
        ├── against the BASE package    must resolve and compile
        │
        └── against the HEAD package    resolve and compile
```

```
BASE succeeds, HEAD succeeds                          -> rejected
BASE succeeds, HEAD fails at the consumer boundary    -> verified
BASE itself fails                                     -> inconclusive
the package environment cannot be reconstructed       -> inconclusive
the verifier cannot execute                           -> unavailable
```

The `BASE succeeds` premise is load-bearing, not ceremonial — see the observed
behaviour below.

## Genuinely external, or it proves nothing

The consumer must live outside the package and resolve through the package
name, not beside the source and resolve relatively:

```
consumer/probe.ts               import { decode } from "pkg/codec";
node_modules/pkg/package.json   the revision's manifest
node_modules/pkg/src/…          the revision's sources
```

That exercises the package name, the exports map, the subpath, the resolution
mode and the entrypoint. A relative specifier bypasses every one of them, which
is exactly the defect being repaired.

## The verifier must not trust the surface

The boundary fact may tell it _which specifier to try_. It must never tell it
whether the import succeeds. A verifier shaped like

```
surface says the boundary is absent -> verified
```

is the analyzer's opinion consulted twice, and an independence witness exists
specifically to make that shape fail: a case where the surface hypothesises a
loss and TypeScript still resolves the specifier at head must come back
`rejected`.

## Diagnostics, established empirically

Observed against the pinned compiler in the virtual layout above, before this
contract was frozen:

```
subpath exported        compiles
subpath withdrawn       TS2307  Cannot find module 'pkg/codec'
no exports map at all   TS2307  Cannot find module 'pkg/codec'
```

The third line is why BASE validity is mandatory. A malformed or unfaithfully
reconstructed package produces the _same_ diagnostic as a genuine withdrawal,
so TS2307 alone proves nothing. It becomes meaningful only under the full
premise set:

```
the BASE external import resolved and compiled
the HEAD package environment was reconstructed the same way
the same consumer specifier was used
and HEAD then failed to resolve it
```

**Scoped to this procedure.** M.3.4's exclusion of TS2307 stands unchanged,
because there the probe is relative and those premises do not exist. The same
code means different things under different evidence, which is why it is
recognised here and refused there.

## Routing by boundary kind

Two materially different boundaries now exist, and the working verifier is not
replaced:

```
module boundary    relative probe        M.3.4, unchanged
package boundary   external consumer     M.3.6
```

Dispatch is on the factual boundary kind, so this adds competence rather than
destabilising what already works.

## Required refutations

Not only the success path:

```
target moves, specifier survives        pkg/codec -> src/new.ts   rejected
barrel or re-export topology changes    consumer still compiles   rejected
internal module disappears, public
  replacement survives                  consumer still compiles   rejected
surface hypothesises a loss that
  resolution disproves                  rejected  (independence)
```

## Evidence required before freeze

The headline witness, with premises asserted rather than assumed:

```
source bytes identical between revisions
module export sets identical
only the package boundary changed
        ->  M.3.5 proposes
        ->  BASE external consumer resolves and compiles
        ->  HEAD same consumer fails at the boundary
        ->  verified, promoted, anchored, published
```

A verifier importing `"./codec"` must fail that witness.

Plus the refutations above, a mutation band of roughly ten to twelve, targeted
execution before manifest admission, survivors classified before anything is
fixed, full verify, and the full historical mutation harness — which caught the
supersession damage last time.

## Scope

Covers reachability of a name through a **declared package consumer
specifier**. Unchanged exclusions: default-export changes, `export * as ns`,
type/value migration of a name reachable in the other space, and changes to a
name's type rather than its reachability. Version ranges, peer dependencies and
runtime-condition exports maps (`import`/`require`/`node`) are out of scope and
named here so they are not smuggled in later.
