# P1-M.3 — API compatibility, frozen contract

Supersedes the M.3 sketch frozen at `43c98a2`, which predated M.3.0 and treated
the family as one capability. It is two.

Built on M.3.0 (`f324630`), which is frozen. M.3 does not modify that layer
unless executable evidence proves a correctness defect in it.

```
M.3.1  removed_export
M.3.2  required_parameter_added
```

Shared infrastructure, separate everything else: candidate kinds, analyzer
reasons, verifier evidence, production witnesses, mutation bands, metrics.
There is no `breaking_change` capability, and a bug in one must not be able to
fail the other's evidence unless genuinely shared machinery is broken.

## The governing question

Not "did the declaration change?" but

> Can a consumer usage **proven valid against BASE** still compile against
> HEAD?

Which fixes the verifier's shape:

```
derive synthetic consumer from the BASE public contract
        ↓
compile it against BASE          ← MANDATORY PREMISE
        ↓
BASE must accept it
        ↓
compile the same logical consumer against HEAD
        ↓
adjudicate ONLY probe-local, capability-specific diagnostics
```

The base-validity step is not a sanity check, it is the thing that makes the
result mean anything. Without it a malformed probe "verifies" every change,
because a probe that never compiled anywhere fails against HEAD too. An
explicit mutation removes this step and must die.

## The public boundary

The boundary is **the module path at which the export was reachable at BASE**,
and the probe imports from that path.

This is what makes reachability rather than declaration persistence the
subject. If a declaration moves to another file but the original path
re-exports it, the probe still resolves and the candidate is refuted. If the
original path stops exposing it, consumers of that path are broken, which is
the fact being reported.

Two consequences worth stating so they are not re-litigated later:

- The API is never identified by the physical declaration file. Moving an
  implementation must not manufacture a break.
- The probe must not silently retarget. A BASE consumer importing an
  entrypoint, probed at HEAD against an internal implementation file, tests
  implementation reachability and answers a different question. The boundary
  identity is part of the candidate's evidence so this stays checkable.

## Analyzer / verifier independence

The analyzer may read: base and head repository-index facts, bindings,
declarations, module and public-export facts, comparison-revision provenance,
and changed syntax. It parses base and head content syntactically.

It must not call TypeScript semantic diagnostics, construct a Program, or
reuse the verifier's compile result. It forms a cheap, deliberately
over-inclusive hypothesis. Duplicating verifier semantics inside it to raise
development precision is forbidden — that trades away the only thing that
makes the second stage informative.

## Base states

M.3.0's four states, used exactly as frozen.

```
present        may reason about compatibility
absent         no "removed from base" or "base-valid call broke" candidate
unavailable    no candidate — the historical premise is not established
not_indexed    no candidate — the historical premise is not established
```

`absent` is positive knowledge. The other two are inability to know, and must
never become "no breaking change".

## M.3.1 — removed_export

**Claim.** A consumer-visible export reachable through a public boundary at
BASE is no longer reachable through that same boundary at HEAD.

Insufficient on its own:

```
base declaration exists · head declaration missing  ->  removed
```

because HEAD may preserve the contract by `export { parse } from "./impl"` or
`export * from "./impl"`.

**Identity** carries repository, base revision, head revision, the boundary,
the exported name, and the namespace (`value`, `type`, or both). Not the
declaration file.

**Probe** matches the namespace. A value export gets a value-position probe; a
type-only export gets a type-position probe. Forcing a type-only symbol
through value space and reporting the resulting error as a removal is a
fabricated finding.

**Outcomes**

```
BASE valid · HEAD recognized missing-export at the probe   -> verified
BASE valid · HEAD resolves the export                      -> rejected
BASE probe itself invalid                                  -> inconclusive
required revision evidence cannot be reconstructed         -> inconclusive
the verifier cannot perform the attempt at all             -> unavailable
```

The last two stay distinct. One is a fact about this claim, the other about
the verifier.

**Must be refuted, not detected:** declaration moved with a named re-export
preserved; direct export replaced by `export *` with the symbol still
reachable; type-only export still type-reachable; an internal declaration that
was never public at BASE; an internal rename behind a surviving public alias.
The analyzer hypothesizing in some of these is acceptable and expected.

## M.3.2 — required_parameter_added

**Claim.** A call shape accepted at BASE is rejected at HEAD because HEAD
requires additional positional arguments.

Not this:

```
head parameter count > base parameter count
```

That rule is wrong, and it is this family's version of M.2's
`UndefinedKeyword` mistake — a plausible syntactic proxy that is not the
semantics. These are all parameter-count increases and none is a break:

```
f(a) -> f(a, b?)              optional
f(a) -> f(a, b = value)       defaulted
f(a) -> f(a, ...rest)         rest
f(a) -> overload added, base-compatible overload retained
```

Maximum parameter count is never the rule.

**Probe** is an arity probe, not a value-construction exercise. Argument types
come from synthetic placeholders (`undefined as never` and similar) so that
what is under test is the accepted arity rather than our ability to invent
representative values.

**Outcomes**

```
BASE valid · HEAD recognized too-few-arguments at the probe  -> verified
BASE valid · HEAD accepts                                    -> rejected
BASE rejects the probe                                       -> inconclusive
```

**Scope.** Positional required arity on exported callables. Explicitly not:
return-type variance, parameter-type variance generally, generic constraint
changes, `this` parameters, constructor compatibility, method override
compatibility. Each is a later capability with its own evidence.

## Diagnostics

Differential and probe-local, for both capabilities:

```
BASE  no capability-relevant diagnostic at the probe
HEAD  a recognized capability diagnostic whose span belongs to the probe
```

Forbidden: comparing diagnostic counts, or concluding from "HEAD has more
errors than BASE". HEAD may carry unrelated errors that have nothing to do
with this claim. Matching is by diagnostic code and probe locality, never by
message text, and compiler-premise tests pin the exact codes the supported
syntax produces against this repository's pinned TypeScript.

## Revision fidelity

Both Programs are built from their own revision's sources. Never a BASE probe
against the current checkout, never a HEAD probe against whatever is on disk.

M.2's `#214` showed a verifier silently collapsing to a fake one-file program,
undetectable because the code already did what the mutation would change it
to. So at least one M.3 witness makes project structure _semantically_
necessary — the boundary re-exports from a second module, so a verifier using
only the changed file reaches a different verdict and fails. `rootNames.length

> 1` is not evidence; a different answer is.

## Deduplication

One logical consumer-visible break is one finding, whatever the number of
governing projects, merged declarations, re-export paths, or diagnostics that
describe it. Project-scoped evidence is preserved underneath.

## Evidence required before freeze

Production witnesses driving `runRealAnalysis` for both capabilities, covering
the genuine break, every refutation listed above, base `unavailable` and
`not_indexed`, an unreproducible project, and the natural-FP sentinel. At
least one case per capability where the analyzer produces a candidate and the
verifier returns `rejected` — a verifier mutated to always confirm must die.

Separate mutation bands, each mutation admitted only after a unique anchor,
a source-changing edit, and a targeted run that executed more than zero tests,
skipped none, and failed on the intended assertion. Survivors are classified
before anything is fixed: `baseline_behaviour_absent` is not `test_weakness`,
and elaborate tests must never be written around behaviour the baseline never
supplied.

Then, because M.3 shares comparison inputs, planning, cache identity, the
analyzer registry, verifier routing, and promotion: the **full** historical
mutation harness. A clean M.3 band proves M.3 only.

## Measurement

Development corpus only during implementation. The holdout stays sealed.
Adversarial fixtures come from this contract, never reverse-engineered from
holdout contents. A development ambiguity is resolved from the principle —
base-valid consumer compatibility — not from expected outputs.

Metrics are reported per capability:

```
M.3.1  candidates · verified · rejected · published
M.3.2  candidates · verified · rejected · published
```

never as "M.3 found two things".

The pre-capability baseline this is measured against, explicitly:

```
historical   3/12
development   1/8
published FP    0
```

The historical baseline is not silently recomputed with today's analyzer set.

## After freeze

Freeze the source, record the freeze SHA, development result, historical
result, natural-FP status and mutation inventory. Only then open the holdout,
once, and record the first observation immutably — including a failure.
A holdout failure informs the next independently specified capability; it is
never a reason to edit M.3 and call the re-run a sealed success.

Then remeasure the whole funnel and let `evaluateM1Gate` decide. Implementation
success — correct mechanism, working independent verification, proven
integration, defended mutations, preserved precision, honestly measured
generalization — is not the same as the quality gate passing. M.3 being
correct while holdout recovery stays insufficient is a valid outcome, and it
means proceed to the next ranked capability, not overfit this one.
