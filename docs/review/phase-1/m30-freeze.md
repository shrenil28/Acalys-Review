# P1-M.3.0 — frozen

Base revision as a first-class, provenance-preserving analyzer input, plus the
cache-identity correction that had to accompany it.

## What this checkpoint claims

> M.3.0 added the base revision as an explicit, provenance-preserving semantic
> input and extended cache and evaluation isolation, **without changing frozen
> review outcomes.**

It does **not** claim improved review capability. M.3.0 ships no analyzer and
no verifier. Recall is unchanged by design, and a checkpoint of this kind that
moved a quality number would be evidence that something leaked, not evidence
of progress. The quality experiment for this family begins at M.3.1.

## Evidence

```
source freeze            3490130
holdout digest           277bad0df521765e5f570adc40c7a65ea9e847317f3e7e991e2f74fe738c7012
verify                   EXIT=0 · 2,360 tests / 0 skipped
dependency graph         330 modules / 0 violations
manifest preflight       228 declared · 228 matched uniquely ·
                         228 change source · 0 invalid before execution
mutation execution       228/228 detected · 227 semantic assertion kills ·
                         1 setup kill (#58) · 0 survived · 0 invalid
```

Pre-run validity and execution are reported separately, and `#58` — the shared
database name — is held apart from the semantic kills, because a suite falling
over is real detection and weaker evidence than an assertion firing.

### The M.3.0 band

Twelve mutations, each targeted alone against its declared suite first, then
re-run inside the full historical harness. All twelve `SEMANTIC_KILL`, all with
`executed > 0` and `skipped 0`.

```
218  comparison identity dropped from the analyzer cache key
219  the cache key identifies the comparison by HEAD instead of base
220  a base that is ABSENT is reported as NOT_INDEXED
221  a base that is UNAVAILABLE is reported as ABSENT
222  a base that is NOT_INDEXED is reported as ABSENT
223  no context item is emitted for an UNAVAILABLE base
224  no context item is emitted for a NOT_INDEXED base
225  a changed path the source never mentioned gets no base entry
226  an unobserved path is synthesized as ABSENT instead of NOT_INDEXED
227  base_revision is allowed to follow the L.5 mode definition
228  the L.5 vocabulary accepts a base-revision observation
229  the containment guard stops requiring a recorded reason
```

Mutations 220-222 are the ones worth naming. Each conflates two of the four
base states, and each had to die against a _distinct_ assertion, because the
whole point of four states is that no two of them may be substituted for one
another. A single test asserting "some state was recorded" would have let all
three survive.

### Two guards that only became testable when they were made testable

`229` would have survived the band as originally written. The containment rule
read module constants directly, so a test could only assert today's
arrangement — which is compatible, and therefore says nothing about what the
guard does when it is not, the only case it exists for. Extracting
`checkFamilyCompatibility(planner, experiment, exclusions)` let the rule be
exercised against families that do not exist.

`218` and `219` needed the context digest held **identical** across the two
bases. With it free to vary, both mutants survive a test that passes for the
wrong reason.

## Funnel, remeasured

```
historical    3/12   published, 0 published false positives
development    1/8   published, 0 published false positives
holdout          —   not reopened
```

Unchanged from the M.2 observation, which is the expected and correct result
for an infrastructure checkpoint.

The holdout was deliberately **not** reopened. M.3.0 adds no analyzer, so its
holdout outcome is predictable by construction, and an observation that buys
no information is not worth spending a seal that can only be spent once.

## What M.3.0 establishes for the capabilities that follow

- base content reaches analyzers only as demand-selected context, never
  broadcast, and never through the subject channel
- the four base states stay four, and only `absent` licenses a negative
  semantic conclusion
- `unavailable` and `not_indexed` compel abstention rather than a silent
  reading of "nothing changed"
- one head compared against two different revisions cannot share a cache entry
- L.5 cannot receive base context in any mode, cannot report it in its frozen
  vocabulary, and cannot gain a fact family without a recorded reason

## Next

M.3.1 `removed_export` and M.3.2 `required_parameter_added`, as separate
capabilities with separate candidate kinds, witnesses, metrics and mutation
evidence, under one M.3 checkpoint. Contract frozen before implementation.
