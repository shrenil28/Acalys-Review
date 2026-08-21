# P1-M.2 capability contract — frozen before implementation

The first capability checkpoint. Family
`configuration_sensitive_type_safety`, rank 1 in the frozen M.1 taxonomy.

Nothing here is code. This exists so the implementation cannot decide the
semantics by accident, the same reason `config-model.ts` preceded the config
parser in L.4.2. Three corrections were made to a draft of this plan during
review, before any analyzer existed, and each is recorded with what it
replaced.

---

## Scope: the capability is narrower than the family

```
semantic family   configuration_sensitive_type_safety
M.2 capability    exact_optional_property_write
```

M.2 handles a property write of `undefined` to an optional property, under a
governing project that enables `exactOptionalPropertyTypes`:

```ts
entry.tag = undefined; // where `tag?: string` and the option is on
```

It does **not** claim to support all configuration-sensitive TypeScript
safety errors. `config-unchecked-index-access` belongs to the same family and
is **not** in M.2 scope; it needs its own capability with its own witnesses.

One general semantic mechanism may cover many surface variants without
pretending it covers a whole taxonomy branch. Naming the capability after the
family would be exactly that pretence.

---

## Correction 1 — option-OFF is analyzer suppression, not verifier refutation

A draft of this plan proposed using "optional property assigned `undefined`
while `exactOptionalPropertyTypes` is OFF" as the fixture proving the verifier
can refute the analyzer. That is wrong, and the error is worth naming: the
analyzer _consumes the governing option_, so it must produce no hypothesis at
all in that case. The verifier would never see a candidate to refute.

Those are two different guarantees and each needs its own fixture:

```
ANALYZER SUPPRESSION
  option OFF
  -> no candidate            (the verifier is never reached)

VERIFIER REFUTATION
  option ON
  syntax is tempting
  semantics permit undefined
  -> candidate
  -> verifier REJECTS
```

The refutation fixture must make the option definitely **on** and the code
definitely **valid**:

```ts
type Maybe<T> = T | undefined;
interface CacheEntry {
  value?: Maybe<string>;
}
declare const entry: CacheEntry;
entry.value = undefined;
```

Under `strictNullChecks` + `exactOptionalPropertyTypes`, assigning `undefined`
to an optional property is an error **unless `undefined` is part of the
declared property type** — which here it is. So a syntax-and-config analyzer
reasonably hypothesises a defect, and the compiler affirmatively finds none.

That is a real independence proof. Without it, a verifier that always confirms
would pass every test.

---

## Correction 2 — governance is plural, and an outage must not erase it

A draft said "if the governing project cannot be determined, abstain". That
phrasing contradicts L.4.2, which established plural governance deliberately.

The states are L.4.2's, unchanged:

```
governed (coverage complete or not)   inspect EVERY governing project
not_governed (complete coverage)      no candidate
undetermined (incomplete coverage)    no candidate
not_indexed                           no candidate
```

The case that matters most:

```
project A definitively governs the file, option ON
project B unavailable
-> A's positive fact survives; a candidate is still formed
```

Erasing a candidate because some _other_ project could not be evaluated would
violate the invariant L.4.2 exists to encode: an outage may prevent a negative
conclusion and must never erase an independently established positive fact.

So the analyzer's evidence is **project-scoped**, not singular:

```
ExactOptionalWriteEvidence {
  sourcePath
  governingProjects[]        every project whose rules admit the file
                             AND whose effective options enable the semantics
  relevantOption             "exactOptionalPropertyTypes"
  coverageComplete           whether every discovered project was evaluable
}
```

Several governing projects enabling the semantics aggregate into **one**
candidate, not one comment each. Publishing the same defect twice because two
tsconfigs admit the file would be a precision failure dressed as thoroughness.

If one project enables the option and another does not, that is not ambiguity.
The truthful claim is scoped:

> This write is invalid under `packages/api/tsconfig.json`'s configuration.

Whether such a partial-governance candidate should be _published_ stays
conservative and is decided by policy, not by the factual layer.

---

## Correction 3 — the verifier reproduces the project, not just its options

A draft proposed:

```ts
ts.createProgram(["changed-file.ts"], governingCompilerOptions);
```

and called that independent verification. It is not. A `Program` is the
project — its root files, module resolution, libs, and host — and semantic
diagnostics depend on that whole environment. Copying `compilerOptions` onto
an arbitrary single-file program produces diagnostics about a project that
does not exist.

The verifier constructs:

```
governing ProjectConfigFact  (from L.4.2, Agent B's parsed output)
        -> effective compilerOptions
        -> the project's actual fileNames as rootNames
        -> module resolution, libs, paths
        -> a REVISION-BACKED host
        -> isolated Program
```

The revision-backed host is not optional. A verifier reading whatever happens
to be in the checkout while adjudicating a claim about H2 can manufacture
evidence from the wrong revision — the failure L.1 made structurally
impossible for the index and which must not reappear here.

### Three outcomes, and "no diagnostic" is not abstention

```
faithful Program + relevant diagnostic present      VERIFIED
faithful Program + relevant diagnostic ABSENT       REJECTED
faithful Program cannot be constructed              INCONCLUSIVE / UNAVAILABLE
```

The middle row is the independent refutation path. When the verifier has
successfully built the exact semantic environment and TypeScript affirmatively
reports no violation, that is a refutation, not an absence of evidence.

Collapsing it into abstention would silently convert every refutation into
"we could not tell", and the analyzer's hypothesis would never be contradicted
by anything.

---

## Diagnostic matching contract

Do **not** match diagnostic prose — it is localized and changes between
compiler releases. Do **not** require the diagnostic span to equal the
candidate span byte for byte; TypeScript may anchor the error on the property
access, the right-hand side, or the whole assignment depending on syntax.

The match requires all of:

```
same revision
same source path
recognized diagnostic code for this capability
diagnostic span OVERLAPS the candidate's semantic region
```

Because the supported syntactic shape is deliberately narrow — a property
write of the `undefined` literal — this overlap rule can be stated exactly
rather than approximated.

---

## Independence, restated as a prohibition

```
the analyzer MUST NOT call semantic diagnostics
```

That is the verifier's entire procedure. An analyzer that asked the compiler
whether the code is wrong would make both stages one opinion consulted twice,
and the funnel's independence — the thing P1-H and P1-J are built on — would
be gone with nothing in the type system to notice.

The analyzer may read: changed syntax, and the effective compiler options of
governing projects. Sharing authoritative source bytes is allowed. Sharing the
inference those bytes support is not.

---

## Required witnesses

One success path is not a trust funnel. M.2 must establish all of:

```
1  option ON, genuine violation
     runRealAnalysis -> candidate -> verifier VERIFIED -> promoted -> published

2  option OFF
     -> no candidate                       (analyzer suppression)

3  option ON, semantics permit undefined
     -> candidate -> verifier REJECTED -> not promoted, not published

4  governance undetermined or not_governed
     -> no candidate

5  project A governs with option ON, project B unavailable
     -> candidate still formed             (positive fact survives outage)

6  verifier cannot faithfully construct the governing Program
     -> INCONCLUSIVE, never VERIFIED

7  the historical natural false positive stays unpublished
     with this capability enabled
```

Witness 7 is why the natural-FP corpus exists. It has nothing to do with this
family, which is the point: a new capability must not disturb a defect the
reviewer already learned not to report.

---

## Sequence, and the rule about the holdout

```
M.1 final harness clean
  -> develop against dev-config-optional-cache-entry ONLY
  -> analyzer, independent verifier, production witnesses
  -> natural-FP regression
  -> mutations 203+, each preflighted AND targeted-executed alone
  -> FREEZE the capability source
  -> first look at the sealed holdout case
  -> full frozen funnel remeasurement
  -> evaluateM1Gate
```

If the development fixture exposes an ambiguity, the capability contract is
corrected from first principles. It is **not** corrected by consulting the
holdout — a failed holdout informs the next independently specified
checkpoint, never an edit against individual holdout cases.

Published precision is measured across the whole frozen evaluation contract
after M.2, not across this family's fixtures alone.

---

## Production invariant earned during implementation

> **The verifier must successfully use at least one governing-project source
> file other than the changed file to establish or refute a candidate.**

Correction 3 of this contract said the verifier must reproduce the project
rather than copy its options. It was implemented in good faith, using
`parsed.fileNames`, and it silently did not work.

`parseJsonConfigFileContent` returns file names rooted at the base path —
`/src/cache.ts` — while the verification context is keyed repository-relative
— `src/cache.ts`. The membership filter therefore rejected every project file,
and `rootNames` only ever contained the changed path. The verifier had been
building exactly the fake one-file program the correction forbids, for its
entire existence.

Nothing detected it. Every fixture was single-file, and in a single-file
fixture a project's file set adds nothing, so the correct implementation and
the broken one produce identical results. The mutation written to defend the
property survived — not because the test was weak about the mutation, but
because **the code already did what the mutation changed it to**.

That is the general lesson worth carrying forward:

```
a mutation surviving does NOT imply a weak test
it may mean the mutated behaviour was never present
```

"Survived means test weakness" is not a safe default. Classification comes
first — implementation, test, fixture premise, mutation, or equivalent — and
here the default would have produced a more elaborate test around code that
did nothing.

### What the fixture must force

Asserting `rootNames.length > 1` would not have caught it either. The fixture
has to make the _semantics_ depend on another project file:

```
globals.d.ts   declares the type
src/cache.ts   writes to it, and never imports it
tsconfig.json  files: ["globals.d.ts", "src/cache.ts"]
```

Only the project's own file list supplies the type. A program built from the
changed file alone cannot resolve it, cannot produce the diagnostic, and
returns `rejected` where the truth is `verified` — a semantic difference, not
an environment error.

Both directions are pinned: with `globals.d.ts` in the project the claim
verifies; with a project listing only the changed file the same sources
refute. Without the second assertion the first would be a statement about
compiler options rather than about project reproduction.
