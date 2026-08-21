# P1-M.3 — public API compatibility

Frozen before implementation, as M.2 was. What is written here is what gets
built; discovering mid-implementation that a decision here is inconvenient is
not grounds to change it, because a contract that moves to fit the code it
governs is a description, not a contract.

Taxonomy rank 2. Two historical misses:
`structural-index-public-signature-declaration`,
`structural-index-export-declaration-drift`.

## Why this is not the analyzer that already exists

`signature-compatibility` already reports incompatible signatures, so the first
question is whether M.3 is redundant. It is not, and the reason is in that
analyzer's own precision conditions — it reports only when

```
the declaration is exported and lives in a CHANGED file
its parameter list is on a line the change touched
a caller was SUPPLIED and was NOT changed
that caller passes fewer arguments than the declaration now requires
```

The third and fourth conditions are the gap. Both historical misses have **no
in-repo caller**:

- `…public-signature-declaration` supplies only `generated/client.ts`, a
  same-name lookalike the case explicitly marks as *forbidden* context. There
  is no call site to be wrong.
- `…export-declaration-drift` is not about parameters at all. A public export
  name disappeared.

So the two rules make different claims from different evidence:

| | `signature-compatibility` | M.3 |
| --- | --- | --- |
| claim | *this in-repo caller is now wrong* | *the published surface broke relative to base* |
| needs | an unchanged supplied caller | the base revision |
| refuted by | the caller passing enough arguments | a base-shaped consumer still compiling |

M.3 is the base-relative sibling of a head-relative rule. Neither subsumes the
other, and M.3 does not modify `signature-compatibility`.

## M.3.0 — base revision as a first-class input (infrastructure, first)

Both misses are base→head comparisons, and **the production pipeline is
head-only**. `ChangedFileSource` carries `content` and `changedLines`;
`AsyncAnalyzerInput.subject` carries `path` and `changedLines`. Base content
exists nowhere an analyzer can reach.

This is not a detail M.3 can work around. Read head-only, neither miss is a
defect at all:

```
format(id, region)                            an ordinary two-argument function
function parse(){}  export { parse as parseInternal }   an ordinary private helper
```

Nothing syntactic distinguishes either from correct code. The defect is
constituted by the comparison, so the comparison has to be available.

### Base arrives as demand-selected context, not on `subject`

`subject` states *what is under review* and deliberately carries no file
content — its own documentation says so, and the reason is that an analyzer
handed content through the subject channel starts reporting pre-existing
defects in any file a change touched.

So base content arrives the way M.2's configuration facts arrive: as a planner
-selected context item, `kind: "base_revision"`, provenance source
`base_revision_facts`, citation naming the path it is the base of. This keeps
gate condition 9 true — context is demand-selected per capability rather than
broadcast — and reuses a path that already has a production witness.

### Absence of base is four states, never one

`baseContent?: string` would collapse distinctions the absence-semantics
invariant forbids:

```ts
type BaseRevision =
  | { kind: "present"; content: string }
  | { kind: "absent" }                      // the file is new at head
  | { kind: "unavailable"; because: string } // base exists, could not be read
  | { kind: "not_indexed" };                // this source cannot supply base
```

The rules that follow, and they are not symmetric:

- `present` — compare; candidates may form.
- `absent` — a **positive determination**. The file is new, so no export can
  have been removed and no signature can have tightened. Emitting nothing here
  is a conclusion, not an abstention.
- `unavailable` / `not_indexed` — **abstain and record a degradation.** Never
  conclude "no break".

That last rule is the one worth stating twice. Concluding "nothing was removed"
because base could not be read is a negative conclusion drawn from an outage,
which the standing rule forbids: positive evidence survives partial outage, an
outage may prevent only a *negative* conclusion. It is also the more dangerous
direction in practice, because it is silent — the funnel cannot otherwise tell
"reviewed, found nothing" from "could not review", and both render as a clean
review.

### The cache key must gain the base, in the same change

`analyzerCacheKey` currently digests

```
repositoryId · headSha · contextDigest · analyzers · procedure · model
```

No base. That is *correct today* — analysis is head-only, so the result really
is a function of head. The moment base becomes an input it is a correctness
bug: one head reviewed against two different bases produces two different
correct results sharing one key. Rebase a pull request, or retarget a branch
from `main` to a release branch, and the previous base's findings are served
from cache.

This is the same shape as M.2's `#214` — code that already does what a mutation
would change it to, undetectable until a new input makes the difference real.
It is fixed in the same commit that introduces the input, not after.

## What M.3 detects

Exactly two things, both base→head, both on the changed file's public surface:

1. **Export removal** — a name exported at base is not exported at head.
   Includes rename-by-alias (`export { parse as parseInternal }`), which
   removes `parse` whatever it adds.
2. **Required-arity increase** — an exported function's count of required
   parameters is higher at head than at base.

Explicitly **out of scope**, and not to be added because the taxonomy has room:
parameter type narrowing, return type widening, property removal from exported
interfaces, generic arity changes, and re-exports through index barrels. Each
is a separate capability earning its own evidence. Widening M.3 to cover them
because they are adjacent is the failure mode the checkpoint forbids.

## Analyzer

Cheap, syntactic, fallible, and forbidden the compiler — the same prohibition
M.2 carries and for the same reason. It compares base and head declarations by
AST shape and reports what looks like a break. It does not ask whether the
break is real; that question belongs to something that can answer *no*.

## Verifier — a base-shaped consumer, compiled against head

The verifier synthesizes a module that uses the API the way base permitted,
adds it to a Program reproducing the **governing project** (the M.2 correction:
reproduce the project, never copy `compilerOptions`), and compiles.

```
export removal      import { parse } from "./parser.js";      -> TS2305 if gone
arity increase      declare const a0: <base type>; format(a0); -> TS2554 if broken
```

- consumer fails to compile → **verified**, the break is real
- consumer compiles → **rejected**, the analyzer's hypothesis is refuted
- the governing project cannot be reproduced → **inconclusive**, never verified

This is refutation, not confirmation, and the refuting cases are the natural
false positives this family actually produces:

- head added the parameter as **optional** (`region?: string`) — the consumer
  still compiles, so `rejected`
- the name is still exported from the same module by another statement — the
  import still resolves, so `rejected`

A verifier that could only agree would pass every other test. Witness 3 of M.2
existed to prove it could disagree; M.3 gets the same witness, because that is
the property that makes the two stages independent rather than one opinion
consulted twice.

### Honest abstention on unannotated base parameters

Synthesizing the arity consumer needs base parameter *types*. When a base
parameter carries no type annotation, the verifier returns `inconclusive`
rather than substituting `any`. Substituting `any` would make the consumer
compile under almost any head, silently converting a verifier into a rubber
stamp that rejects real breaks.

## Evidence required before M.3 is frozen

- production-path witnesses driving `runRealAnalysis`, including the refutation
  witness and both `unavailable` abstention paths
- a witness that the cache key separates two bases at one head
- semantic mutations covering: the base comparison itself, each absence state,
  the cache-key entry, the consumer synthesis, and the verified/rejected split
- the natural-false-positive corpus replayed with no new publication
