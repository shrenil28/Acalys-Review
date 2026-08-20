# P1-L.4.3 - code-to-instruction governance

## Closure

```text
Wave 0 semantic model       c0b6748
Wave 1 integration          93e44f4
Wave 2 source freeze        f50f7f4
```

P1-L.4.3 is closed at the Wave 2 source freeze. The supported boundary is
deliberately narrow: exact `AGENTS.md` artifacts become revision-bound
instruction facts; `README.md`, arbitrary Markdown, source comments, and
imperative-looking prose do not.

## Production seam

The production path is now:

```text
runRealAnalysis
  -> instruction discovery
  -> applicability and coverage
  -> precedence and trust analysis
  -> context planner
  -> assembled context digest
  -> analyzer cache identity
```

The planner retains every applicable instruction and its provenance. Computed
precedence orders nested context before root context without turning
precedence into trust or discarding lower-precedence facts. Authoritative
repository instructions may direct analysis; advisory text remains
non-authoritative.

Incomplete discovery is not absence. Known positive instructions survive a
relevant read outage, and incomplete coverage is supplied as explicit
non-authoritative context. A map of readable repository files does not claim a
complete instruction traversal unless the source port supplies that evidence.

## Independent identities

The production witnesses establish, with unchanged source bytes:

```text
RepositoryIndex serialization and digest   unchanged
ConfigFacts identity                       unchanged
InstructionFacts identity                  changed
selected instruction context               changed
context digest                             changed
analyzer cache identity                    changed
```

Addition and deletion are both covered. The deletion witness executes H1 then
H2 so state accidentally retained across runs is observable. A separate
same-selected-text witness proves that a factual identity change reaches the
context and analyzer identities even when supplied instruction text does not
change.

Recognized instruction artifacts are excluded from the code snapshot used to
build `RepositoryIndex`. Configuration discovery remains independently based
on configuration facts.

## Adversarial correction

The read-only Wave 2 review found three P1 gaps in the first production
implementation:

1. incomplete instruction state with no positive artifact was absent from
   analyzer-visible context;
2. the repository-map fallback claimed complete traversal without evidence;
3. precedence was computed but did not control prompt order.

All three were corrected before integration. The final closure review found no
remaining P0/P1 issue in `93e44f4..f50f7f4`.

The coordinator also closed a generated-path edge case: coverage facts are not
discarded as generated source, collapsed into source pointers, or truncated
into misleading partial uncertainty. Review-engine clustering and deterministic
analyzers keep coverage visible without parsing it as TypeScript or counting it
as changed-source complexity.

## Verification

Focused verification on the source freeze:

```text
instruction suites                 75 passed / 0 skipped
downstream engine suite            33 passed / 0 skipped
combined focused run              108 passed / 0 skipped
```

Full Postgres-required `npm run verify`:

```text
2,164 tests executed
0 skipped

typecheck           PASS
lint                PASS
format              PASS
dependency cruise   PASS (312 modules, 1,125 dependencies, 0 violations)
project references  PASS
schemas             PASS (49 generated files match)
clean build         PASS
export conformance  PASS
Postgres suites     PASS
```

## Mutation evidence

The contiguous L.4.3 band is `154-168`. Before admission, every mutation
matched exactly once, changed source, executed its declared focused suite with
tests greater than zero and zero skips, and failed an intended semantic
assertion.

Targeted band result:

```text
15/15 mutants detected
15 semantic assertion kills
0 setup/startup kills
0 survivors
0 invalid
```

Final serialized full harness:

```text
167 declared, 167 uniquely applicable, 167 source-changing
167/167 mutants detected
166 semantic assertion kills
1 setup/startup kill (#58, pre-existing Postgres harness case)
0 survivors
0 invalid
```

The band covers exact classification, segment-aware scope, plural facts,
precedence-driven prompt order, precedence/trust independence, outage and
absence semantics, production planner consumption, instruction/index/config
identity separation, stale deletion, and provenance-aware deduplication.

## Non-claims

P1-L.4.3 does not claim:

```text
support for instruction conventions beyond AGENTS.md
real Git checkout/traversal or symlink semantics at the AnalysisSource port
Git object-to-tree binding from the synthetic unchanged-source witnesses
minimal cache invalidation for irrelevant sibling instruction fact changes
that instruction or coverage context always fits an insufficient token budget
review-quality, latency, token, or cost improvement
```

Irrelevant sibling fact changes may conservatively invalidate instruction
context identity. Insufficient-budget omissions remain explicit. Neither is an
incorrect reuse or a false negative-absence claim.
