# P1-L.4.2 — code-to-config governance

**Status: CLOSED at `5b31de7`.**

The claim, narrowed to what production and the closing evidence establish:

> P1-L.4.2 derives CODE-to-CONFIG governance from TypeScript's own project
> parsing rather than directory proximity. It distinguishes governed,
> not-governed, and undetermined; preserves independently established positive
> governance through partial failures; and permits negative absence only with
> complete discovery and usable membership. Source governance, option
> inheritance, and project references remain separate fact types. Config-only
> changes remain outside `RepositoryIndex` identity while changing selected
> analyzer context and analyzer-input identity.

---

## Three relationships

The implementation records three facts rather than one generic config edge:

```text
SourceGovernance   source file -> project whose rules admit it
OptionInheritance project -> config supplying inherited options
ProjectReference  project -> referenced project
```

An `extends` target does not govern the child's source files, and a referenced
project does not govern the referencing project's files. Governance is plural:
if a root project and a nested project both admit one source file, both
relationships survive.

Membership is compiler-backed. `ts.parseJsonConfigFileContent` and
TypeScript's own `matchFiles` implementation establish the admitted file set;
directory proximity is not a membership rule.

---

## Completeness by fact dimension

A parsed project can carry different certainty for different facts:

```text
membership           complete | incomplete | unusable
option inheritance   complete | incomplete
reference discovery  complete | incomplete
```

The distinction was required by two different diagnostic classes.

An unresolved `extends` may leave explicit child membership trustworthy while
making inherited options incomplete. If selectors could have come from the
missing base, membership is incomplete: known positives may survive, but
absence is not established.

A malformed membership selector such as `files: [42]` or `include: 42` makes
TypeScript's recovered membership unusable. That project contributes neither
positive governance nor negative absence. A valid sibling project's positive
relationship still survives, with incomplete coverage attached.

Malformed `references` are independent from membership. Valid membership and
valid reference entries survive, while reference discovery and the discovered
project graph remain incomplete. Compiler-option diagnostics affect option
completeness. Any semantic diagnostic not classified at this boundary falls
back conservatively: recovered membership is unusable and the other dimensions
are incomplete.

This gives the governing invariant its full form:

> A failure may prevent a negative conclusion, but it must not erase an
> independently established positive fact. Parser recovery is positive
> evidence only when the input dimension that produced it was valid.

---

## Production identity witness

The closing witness runs through `runRealAnalysis`, not a library-only helper:

```text
repository snapshot
  -> project discovery
  -> compiler-backed config facts
  -> governance
  -> planner selection
  -> assembled context
  -> context digest and analyzer cache key
```

For H1 and H2 it independently proves:

```text
source bytes H1 == source bytes H2
RepositoryIndex canonical serialization H1 == H2
RepositoryIndex digest H1 == H2

ConfigFacts digest H1 != H2
selected config context H1 != H2
context digest H1 != H2
analyzer cache key H1 != H2
```

The same production seam distinguishes complete negative governance from
`undetermined`, and carries a valid project's positive relationship through an
unavailable sibling config.

Config facts remain factual context. They do not promote candidates, decide
verification, publication, or merge blocking.

---

## Adversarial correction

The read-only Wave-2 review found a real trust-boundary defect: JSON-parseable
but semantically invalid `files` and `include` fields were treated as available
membership. TypeScript can recover those two examples in opposite directions:

```text
files: [42]   -> diagnostic + empty recovered set
include: 42   -> diagnostic + tempting positive recovered set
```

Treating recovery as complete would therefore permit both false absence and
false governance. Independent compiler-premise tests established the behavior
before the diagnostic-impact classifier was implemented. Malformed reference
premises likewise showed that source membership can remain trustworthy while
reference discovery becomes incomplete.

The correction also retargeted two provisional mutations whose names exceeded
their transformations: `#137` now changes an unavailable config into an
available one, and `#141` now leaks a project reference into
`SourceGovernance`. Their declared suites kill those exact propositions.

---

## Closing evidence

Focused mechanism and production-witness suites:

```text
54 tests executed
 0 skipped
```

Fail-closed repository verification:

```text
ACALYS_REQUIRE_POSTGRES=1 npm run verify

2,087 tests executed
0 skipped

typecheck           PASS
lint                PASS
format              PASS
dependency cruise   PASS (307 modules, 1,114 dependencies)
project references  PASS
schemas             PASS
clean build         PASS
export conformance  PASS
Postgres suites     PASS
```

Mutation preflight:

```text
152 declared
152 matched uniquely
152 change source
0 structurally invalid
```

One serialized full mutation run on the verified tree:

```text
152/152 mutants detected
151 semantic assertion kills
  1 setup/startup kill (#58, pre-existing Postgres harness case)
  0 survivors
  0 invalid
```

The L.4.2 band is `133-153`. Its 21 targets all produced semantic assertion
kills with executed tests greater than zero and zero skips. They cover plural
governance, outage resilience, complete-negative standing, discovery versus
proximity, unavailable configs, unresolved inheritance, edge-type separation,
production context consumption, config-only identity, malformed membership,
reference completeness, and the unknown-diagnostic fallback.

---

## Non-claims

P1-L.4.2 does not claim:

```text
discovery of unconventionally named projects that nothing references
multi-entry extends arrays beyond the first established parent
bare-specifier extends resolution through node_modules
that every inherited config belongs in analyzer context
that config facts adjudicate verification or publication truth
review-quality, latency, token, or cost improvement
```

The planner currently selects positively governing project configs. Broader
inheritance-chain context is a future bounded-selection and measurement
question, not part of this closure claim.
