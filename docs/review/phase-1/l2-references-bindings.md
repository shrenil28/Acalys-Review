# P1-L.2 — references and bindings

**Status: implementation complete, gates green, mutation evidence clean.**

The claim, stated narrowly:

> For repository references within supported TypeScript/JavaScript coverage,
> Acalys can represent the exact checker binding from a reference to its symbol
> and declaration set, and explicitly represent cases where that binding cannot
> be established.

---

## The fixture, and why it is shaped that way

Invariant 7 in its ideal form. Removing the precision mechanism must not merely
produce _nothing_ — a plausible wrong answer has to be waiting:

```ts
import { save } from "./store.js";

export function run(save: () => number): number {
  return save(); // the PARAMETER
}

export function outer(): number {
  return save(); // the IMPORT
}
```

Two calls, spelled identically, binding to different symbols. Name matching
answers "the imported `save`" for both and is wrong for the first — not wrong
in a way that errors, but wrong in a way that hands a reviewer a real
declaration from a real file to read and believe.

---

## Two record types, because they have different failure modes

`ReferenceRecord` and `BindingEdge` are separate. The reference certainly
exists — it is text in a file. The binding may not be establishable. Fusing
them forces an unresolvable reference to be either invented or dropped, and
dropping it turns "we could not resolve this" into "nothing uses that".

Every reference gets an edge, including unresolved ones.

`external` and `unresolved` stay apart for the same reason `absent` and
`not_indexed` do in L.1:

```
exact        bound to a symbol this index knows
external     bound, and nothing here declares it — a dependency
unresolved   the checker could not bind it at all
```

Only the second tells a reviewer the reference is fine and simply not ours.

Import aliases are followed to the declaration, with `viaAlias` recorded.
Answering "where is `save` declared?" with "on the import line" is true and
useless — but _whether_ a reference arrived through an import is a fact a
reviewer wants, and one a `symbolId` alone cannot carry.

---

## Module resolution, and how its absence lied

L.1 never needed it: declarations come from walking one file at a time, so an
unresolved import cost nothing visible. L.2 does, and the failure was
deceptive rather than loud:

```
import cannot be resolved
  -> alias symbol the checker declines to follow
  -> every cross-module reference reports `external`
  -> "bound, but outside our world" is indistinguishable from
     "we could not find the file"
```

Every binding in the first run came back `external` with zero declarations,
which reads as a modelling decision rather than a missing hook. The verifier's
program had already learned this exact lesson — its comment records that
supplying only the deprecated `resolveModuleNames` silently resolved nothing —
and the same `resolveModuleNameLiterals` shape is used here.

---

## Production wiring, in the same commit

```
runRealAnalysis            the production entry
  -> buildRepositoryIndex  references and bindings for the revision
  -> planContext(index)    bound callees enter planning
  -> AssembledContext      the fact survives scoring and the budget
  -> buildClusters         it reaches what the analyzer is handed
```

Bound callees replace the planner's name-matched import candidates, under the
same precedence rule L.1 established: the indexed answer dominates when
positively established, and where no binding exists the syntactic candidate
stands.

Calls only. A changed file references many names — types, reads, imports — and
offering every bound declaration would spend the budget on everything the file
mentions.

---

## Evidence

```
mechanism witness   14 tests   packages/code-intelligence/tests/repository-bindings.test.ts
wiring witness       5 tests   apps/review-worker/tests/binding-wiring.test.ts
repository total  1,945 tests   0 skipped
depcruise           299 modules, 0 violations
```

**Pre-run validity:**

```
99 declared
99 matched uniquely
99 change source
 0 structurally invalid
```

**Execution:**

```
99/99 mutants detected
  98 semantic assertion kills
   1 setup/startup kill   (#58, the Postgres harness — see l1-repository-index.md)
   0 survived
   0 invalid
```

The seven L.2 mutations, every one a semantic assertion kill with `skipped 0`:

```
 94  bindings resolve by name instead of by the checker's symbol   exec 14  fail 2
 95  import aliases are not followed to the declaration            exec 14  fail 5
 96  `external` collapses into `unresolved`                        exec 14  fail 1
 97  unresolvable references are dropped instead of recorded       exec 14  fail 2
 98  `not_indexed` collapses into `unbound` for bindings           exec 14  fail 1
 99  an unusable index still yields bound callees                  exec 14  fail 1
100  the production path stops consuming bindings                  exec  5  fail 2
```

94 is the one the checkpoint exists for.

### Two survived the first pass, and both were test weaknesses

Recorded because the classification is the point — neither was an
implementation defect:

```
external -> unresolved
  the assertion read expect(["external","unresolved"]).toContain(...).
  An assertion that accepts both sides of a distinction cannot defend the
  distinction. Split into two tests that must disagree with each other.

unusable index still yields callees
  the fixture had no records to withhold, so the guarded and unguarded
  branches produced the same downstream state — identical to L.1's #92.
  Fixed with a populated index marked `invariant_failed`, premises asserted
  before the conclusion.
```

### The preflight earned its place here

The run refused to start:

```
Mutation manifest preflight FAILED — 97 of 99 applicable.
  #88  anchor matches 2 sites in planner.ts; it must identify one
  #92  anchor matches 2 sites in planner.ts; it must identify one
```

Not anchor rot. L.2 added a second index-provenance block and a second
usability guard, so anchors that identified one site each now identified two —
and a two-site anchor mutates whichever comes first, which is not the site the
definition names. Both would have run to completion and reported a verdict
about the wrong line.

Caught in 40ms. The **uniqueness** half of the check is what caught it; a
"matched at least once" preflight would have passed both through.

---

## What L.2 does NOT claim

- full call graph
- type graph
- barrel re-exports, namespace imports, default imports
- path aliases
- overload set selection at a call site
- genuine reference ambiguity (`ambiguous` remains unreachable — see
  [l1-repository-index.md](./l1-repository-index.md))
- incremental indexing or persistence
- any analyzer-quality improvement

The carry-forwards from L.1 stand unchanged: unscoped tenant identities are
non-persistable, and review-quality effect remains unmeasured until L.5.
