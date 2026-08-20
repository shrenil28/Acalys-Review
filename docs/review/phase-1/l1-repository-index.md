# P1-L.1 — canonical repository intelligence

The central claim, stated narrowly on purpose:

> For a specific repository revision, Acalys can produce canonical,
> provenance-bearing structural facts about production code, and at least one
> real review path consumes those facts.

Not "we have a code graph". Not "indexing is complete". The claim is small
enough that the evidence below either establishes it or does not.

---

## What an index is

```
a statement about ONE repository at ONE revision,
produced by ONE extractor under ONE schema,
describing WHAT EXISTS and HOW WE KNOW.
```

Every clause is in `RepositoryIndexIdentity`, and the revision is not a field
on the side — it is part of the identity:

```
index(H1)  !=  index(H2)
```

even when 99.9% of the records would be reusable. A finding cites index facts,
and "the declaration is at line 40" is only true of a revision. There is
deliberately no mutable `latestIndex` handed to review code: a caller must name
the revision it means, because a caller that cannot name it does not know what
its answer describes.

`indexSchemaVersion` and `extractorVersion` are in the identity **and** in the
digest preimage. A cached artifact from an older extractor is not the index
today's code would build, and reusing it is how a fixed extraction bug quietly
stays fixed only in new repositories.

---

## Facts, and only facts

`ModuleRecord`, `SymbolRecord`, `DeclarationRecord`. No `isBuggy`, no
`riskScore`, no `likelyAsyncBug` — asserted structurally by a test that walks
every record's keys, not promised in a comment.

The reason is architectural rather than tidiness:

```
     RepositoryIndex                NOT:  RepositoryIndex
       ^         ^                              |
       |         |                        BugDecisionEngine
  Analyzer   Verifier                        /        \
                                       Analyzer      Verifier
```

Both may stand on the same factual substrate. If both could also ask it to
settle the _contested_ question, two independent opinions would become one
opinion consulted twice, and the independence P1-H and P1-J are built on would
be gone with nothing in the type system to notice.

---

## `ambiguous` is not declaration multiplicity

TypeScript lets one logical symbol have several declarations, and that is
ordinary rather than uncertain:

```ts
interface Foo {
  a: string;
}
interface Foo {
  b: number;
} // one symbol, two declarations
```

The first version of the extractor recorded that as `resolution: "ambiguous"`,
and worse, as **two symbols** — because `symbolId` was derived from the
declaration span. Both were wrong, in opposite directions:

```
a name-and-module key    merges two distinct locals in different scopes
a span key               splits one merged interface into two symbols
```

Grouping is now by the **checker's** symbol, which is the reason a `Program` is
built at all. Merged interfaces are one `exact` symbol with
`declarationCount: 2`; two same-named `helper` functions in different scopes are
two symbols with one declaration each. Both are tested.

`ambiguous` is reserved for its real meaning — a _reference_ that could denote
more than one symbol and cannot be narrowed to one. L.1 records no references,
so it is **currently unreachable at a declaration site**, and a test asserts
that rather than leaving the claim in prose. When L.2 makes that test fail,
that is the vocabulary being used correctly.

Spending `ambiguous` on multiplicity would have left nothing to say when
reference resolution genuinely cannot decide — and L.2's bindings lean entirely
on that distinction.

---

## Absence is a claim, and claims need standing

`symbolNamed` returns three things, not two:

```
found         here it is
absent        the module WAS indexed, and has no such symbol
not_indexed   we do not know — it was never successfully read
```

Collapsing the third into the second turns an indexing failure into a factual
claim. `RESOLUTIONS` exists for the same reason one level down:

```
exact | ambiguous | external | unresolved
```

so that "we could not resolve it" never silently becomes "it does not exist" —
the closed-world mistake P1-J spent a checkpoint learning to name.

Failure is modelled now rather than when it first happens:
`IndexAvailability` distinguishes `built` / `unavailable` / `unsupported` /
`invariant_failed`, and `unavailableIndex()` is not an empty index. To a caller
that only counts records the two are identical, and that identity is exactly
how an outage comes to read as "nothing found" — the shape P1-K caught
rendering a verifier outage as a clean scan.

---

## indexed != production reachable

A file can be indexed, classified `production`, and still be unreachable dead
code. The architecture census answers reachability; this does not, and they are
kept apart deliberately. An index that silently dropped unreachable
production-looking code would let the index and the reachability gate hide each
other's defects: the index would have no record to contradict the census, and
the census no record to explain.

Supported means correct; unsupported means explicit. A Python file is recorded
with `coverage: unsupported_language`, never omitted — an omitted file leaves
the index quietly claiming the repository is all TypeScript.

---

## Full rebuild only

No incremental path, no cache, no `H1 + changed files -> H2`. That is the
foundation L.3 will be judged against:

```
digest(full(H2))  ==  digest(incremental(H1 -> H2))
```

An oracle written after the optimization it judges tends to be written in the
optimization's own terms.

The digest is a function of the record **set**, not of the array it arrived in.
`canonicalSerialization` re-sorts rather than trusting its input, because it is
the _definition_ of canonical form and a definition that assumes its input is
already canonical defines nothing. This matters concretely: an incremental
build will emit records in whatever order invalidation visited them.

Two defects were found here by trying to kill the tests rather than by reading
the code:

**The determinism test was vacuous.** It built two indexes from `Map`s in
different insertion orders and compared digests. The builder walks a _sorted_
key list, so that assertion held with every canonical sort deleted. Replaced
with one that scrambles the record arrays directly — the only construction that
can observe whether canonical form is applied at all.

**The digest joined fields with nothing between them.** `["a", "bc"]` and
`["ab", "c"]` produced identical preimages, so two different indexes could
digest equal. The first test written for it was also wrong — it compared
`"ab/c.ts"` to `"a/bc.ts"`, two different strings that never collided.

The first _fix_ was also not good enough. A separator only works while no field
can contain it, and these fields hold paths, symbol names, and compiler
diagnostic text; choosing a byte nobody uses today is a bet on tomorrow's
inputs. The encoding is now length-prefixed, so a reader never has to find a
boundary:

```
("a",  "bc")   ->   1:a2:bc
("ab", "c")    ->   2:ab1:c
("a:b","c")    ->   3:a:b1:c      a colon in the value changes nothing
```

Absence gets `-:`, which is outside the value alphabet — a length is a
non-negative integer, so no encoded field can begin with `-`.

A correction to what this document said at `e9f5aa8`: it claimed the
intermediate `~` sentinel "had the same bug one level down", and that is false
of the code as shipped. It was true only of a version where `line` re-encoded
its parts and compared against the sentinel. In the final shape `line` takes
`string | undefined` and encodes exactly once, and every encoded field contains
a colon — so no encoded value can equal a bare `~`. `-:` is the better choice
for a different reason (a length can never start with `-`, so the property is
readable rather than argued), but the switch fixed nothing.

The mutation written to guard it said so: planting `~` in place of `-:` left
all tests green, because it is an equivalent mutant. It was retargeted at
`line`'s absent branch, which does carry the property.

The property, now testable rather than believed:

> Distinct canonical tuples cannot share a digest input.

---

## The production wiring witness

This is the half P1-K got wrong, so it is in the same commit as the mechanism,
not appended after an audit.

```
runRealAnalysis            the production entry
  -> gitObjectId(headSha)  the revision, resolved
  -> buildRepositoryIndex  the seam
  -> planContext(index)    the fact enters planning
  -> AssembledContext      the fact survives scoring and the budget
  -> buildClusters         the fact reaches what the analyzer is handed
```

The fact carried is the declaration a changed hunk sits inside, resolved by the
checker across the whole revision rather than by parsing one file alone.

**Why the witness cannot pass with the seam bypassed.** The planner keeps its
syntactic path, so "an item covering the changed function is present" stays
true with the index removed entirely — a vacuous assertion of exactly the shape
that left P1-K's seams call-site inert behind passing tests. Three independent
things are asserted instead:

```
provenance names repository_index, not direct_source
recordId resolves to a declaration record in the index the run built
indexIdentity carries the revision under review
```

### Representation precedence

A design question surfaced while wiring this. `scoreCandidates` dedupes on
`path|start|end`, so the syntactic candidate and the indexed one collided —
and the syntactic one won, because it was generated first. Both could have been
kept, but they carry identical text and the planner exists to stop the budget
being spent twice on one function.

The first fix skipped the syntactic candidate at generation time, which worked
and was fragile: precedence lived in traversal order, so a refactor could
reverse it silently. It is now one rule, applied in one place:

```
same semantic location + indexed observation positively established
  -> the indexed representation dominates
```

"Positively established" is load-bearing. An index that failed to build, or
that could not read this module, produces no indexed candidate at all — so the
syntactic one is what remains. An incomplete index must cost the richer fact,
never the context itself. Four tests hold the rule down: indexed wins when
generated second, indexed wins when generated **first**, syntactic survives
with no index, and syntactic survives when the index is unavailable or the
module failed to parse.

What changes is not how many items there are, but what the item can say about
itself.

---

## Evidence

```
mechanism witness   46 tests   packages/code-intelligence/tests/repository-index.test.ts
wiring witness       9 tests   apps/review-worker/tests/index-wiring.test.ts
repository total  1,925 tests   0 skipped
depcruise           299 modules, 0 violations
```

Twelve mutations, planted and each watched to fail, now permanent as ids 77–88
in `scripts/mutate-p1i.mjs`:

```
77  index identity ignores the revision
78  extractor version leaves the digest preimage
79  symbol identity ignores the module (same-name merge)
80  not_indexed collapses into absent
81  canonical form follows the array order it was handed
82  digest joins fields with nothing between them
83  unsupported language skipped rather than recorded
84  a module that failed to parse recorded as indexed
85  unavailable index built as an ordinary empty one

86  production plans without the repository index
87  index built for a revision that is not the head
88  index-derived item claims direct-source provenance

89  declaration multiplicity reported as resolution ambiguity
90  an unscoped index reports itself as persistable
91  the syntactic representation wins over the indexed one
92  an unusable index still suppresses the syntactic fallback
93  absence encoded inside the value alphabet
```

Three were retargeted rather than kept, and the first two rotted for the
ordinary reason — the code they pointed at stopped existing:

```
79  pointed at the span-derived symbolId the checker-grouping fix removed
82  pointed at the separator that length prefixing replaced
93  pointed at the sentinel's spelling, which is an equivalent mutant
```

The full run that established this was not clean, and the failures were all in
this checkpoint's own new work:

```
79  INVALID    the retarget silently missed its anchor, and I did not verify it
92  SURVIVED   the fallback test could not observe the guard it named
93  SURVIVED   equivalent mutant
```

**92 is the one worth reading twice.** The test asserted that an unavailable
index leaves the syntactic candidate standing — and it passed for the wrong
reason. `unavailableIndex` carries no records, so `declarationAt` returns
nothing whether or not availability is consulted; deleting the usability check
changed no observable behaviour. The replacement uses the state that actually
distinguishes them: records present, `availability: invariant_failed`. That is
a reachable outcome — a build can populate records and then fail a consistency
check — and it is why `IndexAvailability` has a fourth case.

This is the same shape as the two defects found while writing the digest: a
test that varies an input dimension the code has already normalized cannot
observe the code being wrong.

The split is the checkpoint's point. 77–85 dying proves the facts are correct.
Only 86–88 dying proves anything uses them.

---

## Mutation closure

Reported in two stages, because `0 invalid` is only meaningful if it was not
produced by filtering malformed definitions out of the denominator.

**Pre-run validity** (`scripts/mutate-p1i.mjs --preflight-only`):

```
92 declared
92 matched uniquely
92 change source
 0 structurally invalid
```

**Execution:**

```
92 killed
 0 survived
 0 runtime-invalid
```

Of the 92 kills, **91 were killed by a failed semantic assertion** with
`executed > 0` and `skipped 0`. One was not, and it is recorded rather than
folded in:

```
#58  every suite shares one database name
     executed 0   skipped 5   failed 0
     verdict  KILLED — suite could not run
```

That is a documented kill class, and it exists because the opposite was once a
harness bug: Vitest reports a test whose `beforeAll` threw as "skipped", an
earlier parser counted those as executed, and a mutation that broke setup
outright read as SURVIVED. A mutation that makes its suite unable to start has
been detected. But it is a **weaker** kill than an assertion failure — it
proves the mutation is detectable, not that a specific expectation caught the
specific wrong behaviour — so it is counted separately and not described as
"0 skipped".

### The seventeen L.1 mutations

Every one killed on a failed assertion, `skipped 0`:

```
77  index identity ignores the revision                        exec 46  fail 1
78  extractor version leaves the digest preimage               exec 46  fail 1
79  symbols grouped by name, not by the checker's symbol       exec 46  fail 3
80  not_indexed collapses into absent                          exec 46  fail 1
81  canonical form follows the array order it was handed       exec 46  fail 1
82  the digest drops its length prefixes                       exec 46  fail 3
83  unsupported language skipped rather than recorded          exec 46  fail 1
84  a module that failed to parse recorded as indexed          exec 46  fail 3
85  unavailable index built as an ordinary empty one           exec 46  fail 1

86  production plans without the repository index              exec  9  fail 6
87  index built for a revision that is not the head            exec  9  fail 3
88  index-derived item claims direct-source provenance         exec  9  fail 6

89  declaration multiplicity reported as resolution ambiguity  exec 46  fail 2
90  an unscoped index reports itself as persistable            exec 46  fail 2
91  the syntactic representation wins over the indexed one     exec 46  fail 1
92  an unusable index still suppresses the syntactic fallback  exec 46  fail 1
93  an absent field is encoded as an empty one                 exec 46  fail 1
```

86–88 are the wiring mutations. Their suite is the nine-test production
witness, which is why `exec 9` rather than 46 — and six of nine failing on
86 and 88 is the seam being genuinely load-bearing rather than decorative.

### The three that failed the first attempt

The first full run returned 89 killed, 2 survived, 1 invalid. All three were
in this checkpoint's own new evidence, and all three are now killed:

```
79  stale mutation definition
    a retarget's anchor rotted after reformatting and nobody knew until a
    full run finished
    -> preflight now refuses in ~40ms; killed, 3 tests failing

92  a guard test masked by empty records
    `unavailableIndex` holds no records, so the lookup returned nothing
    whether or not the guard ran
    -> a populated index with `availability: invariant_failed` makes the
       branches differ; both premises asserted before the conclusion; killed

93  an equivalent mutant
    it targeted the absence sentinel's spelling, which is unobservable
    -> retargeted at `line`'s absent branch, which carries the property;
       killed
```

The failed run improved the checkpoint. Two of the three were weaknesses in
the _proofs_, not the implementation — which is the outcome a mutation gate
exists to produce.

---

## What L.1 does NOT claim

Stated explicitly, because each is a plausible thing to assume from the word
"index":

- incremental indexing
- persistent cross-run cache
- full call graph
- full type graph
- test associations
- semantic or vector search
- cross-language indexing
- cross-revision symbol continuity
- any performance improvement
- any review-quality improvement

`symbolId` is derived from the canonical _first_ declaration of a
checker-resolved symbol — revision, module, span, and kind — and is
deliberately
**not** a cross-revision fingerprint. Renames, moves, splits, and merges each
break any fingerprint simple enough to compute here, and a fingerprint that is
wrong across revisions is worse than none: it claims continuity that does not
hold, and downstream code would carry a finding from one declaration to a
different one. Continuity gets its own semantics later, as explicit records.

L.1's supported extractor is the TypeScript/JavaScript project graph. Production
grade does not mean pretending universal support; it means `supported ->
correct`, `unsupported -> explicit`.

---

## Known limits

- **No analyzer decision changed.** The index reaches the analyzer's context
  and is not yet consulted by any analyzer rule. That is L.5's work, and
  claiming a quality effect here would be claiming something unmeasured.
- **The wiring witness's last hop is asserted, not observed from inside an
  analyzer.** `buildClusters` is called with the production path's own
  assembled items, which is the same function `runRealAnalysis` uses — but the
  assertion sits beside the analyzer rather than inside it.
- **Tenant identity is `unscoped`, and that is a hard prerequisite, not a
  cosmetic default.** The first version wrote `tenantId: "unknown"`, and the
  claim beside it — "tenants cannot collide" — was wrong. A placeholder string
  is a value in the _same domain_ as a real tenant id, so two tenants entering
  through callers that supply nothing both become `"unknown"` and their
  identities compare equal, with nothing in the type stopping that index being
  handed to the other tenant.

  `TenantScope` now makes the two cases different shapes, and `isPersistable`
  refuses `unscoped`. A test demonstrates the collision directly — two
  unscoped identities, everything else equal, comparing equal — so the hazard
  is visible rather than latent.

  **Real tenant identity is mandatory before any index is persisted, cached, or
  shared across runs.** L.1 builds, uses, and discards the index inside one
  call, so nothing crosses a tenant boundary today.
