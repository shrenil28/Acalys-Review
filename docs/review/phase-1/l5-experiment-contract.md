# P1-L.5 - repository-intelligence quality and economics experiment

**Status:** PRE-REGISTERED. No L.5 treatment result may be inspected before the
contract and corpus are frozen in Git.

## Question

P1-L.5 answers one question:

> Did P1-L.1 through P1-L.4 improve the review product, and at what measured
> cost?

This is a measurement checkpoint, not a repository-intelligence capability
checkpoint. Correct facts may remain indexed even if this experiment concludes
that the planner should not currently consume them.

## Frozen starting point

```text
P1-L.4 closure                  c39b78d
P1-L.4 source/mutation freeze   f50f7f4
```

No L.1-L.4 production semantics may be changed to improve an L.5 result. Any
correctness defect discovered while building the harness is fixed and reviewed
before the experiment restarts from a new explicitly recorded freeze.

## Experimental unit and modes

One unit is one fixed corpus case at one fixed synthetic revision. Control and
treatment run against byte-identical files, change manifest, gold labels,
analyzer set, verifier policy, publication policy, and token budget.

```text
CONTROL
  repository index facts unavailable to the planner
  binding-derived callers unavailable
  test relationships unavailable
  ConfigFacts unavailable
  InstructionFacts unavailable

TREATMENT
  the current P1-L.1-L.4 production path
  RepositoryIndex + bindings + test relationships
  ConfigFacts governance
  InstructionFacts applicability + precedence + trust + coverage
```

Both modes retain the changed source and the pre-L syntactic planner behavior.
Control is an explicit null repository-intelligence input, not a different
repository snapshot and not a historical checkout with unrelated code changes.

Five treatment ablations run for attribution only:

```text
TREATMENT minus structural_index
TREATMENT minus binding
TREATMENT minus test_relationship
TREATMENT minus config_governance
TREATMENT minus instruction_governance
```

An ablation changes only whether one established fact family is offered to the
planner. It may not change discovery, gold labels, analyzers, verification, or
publication policy.

## Equivalence identity

Before execution, each mode records a canonical hash over:

```text
experiment schema version
case id and corpus version
synthetic revision
repository path/content manifest
changed paths, contents, and changed lines
gold finding labels and required/forbidden context labels
analyzer ids and procedure versions
planner and experiment-harness schema versions
verifier policy version
publication policy
premerge policy
context token budget
execution limits
model and provider execution identity
initial analysis-cache state
previous-index identity and availability
instruction traversal and artifact-read observations
```

The control/treatment pair must have the same equivalence hash. Mode and
ablation identity are hashed separately and must differ. The mode identity also
hashes the actual fact families offered at the planner input seam. A common
input mismatch invalidates the pair rather than becoming an outcome.

Each run emits a mode-attestation manifest at offered, scored, and selected
stages. Control must contain zero L-family provenance. Each ablation must differ
from full treatment by exactly its named family. The pre-repository-intelligence
direct-source candidate multiset must be identical across all modes before
repository facts compete for selection. An attestation failure invalidates the
run.

## Fixed corpus contract

The corpus is committed before the first aggregate report is produced. Every
case states why each expected finding and required/forbidden context item is
correct. The minimum composition is:

```text
structural-index positive cases              >= 2
binding-only positive cases                 >= 2
test-relationship positive cases            >= 2
config-governance positive cases             >= 2
instruction-governance positive cases        >= 2
multiple-family interaction cases            >= 2
clean/no-finding controls                     >= 4
incremental revision pairs                    >= 4
cache identity pairs                          >= 8
  expected reuse                              >= 2
  config-only invalidation                    >= 2
  instruction-only invalidation               >= 2
  context-selection invalidation              >= 2
```

These are distinct-case minima. A family-only case is eligible only when it
declares exactly one repository-intelligence exposure family and the required
exposure is present in full treatment, absent in that family's ablation, and
unchanged in every other ablation. Interaction cases do not count toward a
family-only minimum. Every named family has at least two distinct gold finding
opportunities. A context-only case may test selection but cannot satisfy a
quality-family minimum.

At least one config and one instruction case keep changed source bytes stable
across their identity pair. At least one instruction pair is a deletion. At
least one outage case retains a known positive while coverage is incomplete.

Cases may reuse the existing planner and analyzer corpora, but their L.5 gold
labels are copied into the frozen L.5 corpus rather than inferred from current
production output.

Every gold finding has a stable `goldId` and an authored matcher containing:

```text
rule id
correctness family
exact repository path
allowed anchor-line interval
```

The interval is justified by the fixture and cannot be widened after results.
Candidate and published scoring use deterministic maximum-cardinality bipartite
matching. Among equally large matchings, sort by `goldId` and then by candidate
semantic identity. One output can match at most one gold finding and one gold
finding can match at most one output. Unmatched gold is a false negative. Every
unmatched output, including the second and later duplicate of a true finding,
is a false positive. Family-only matching is forbidden.

Candidate semantic identity is the canonical tuple:

```text
case id, rule id, correctness family, category,
path, start line, end line, analyzer identity hint
```

This tuple, not array position, pairs unmatched false positives across modes.

## Outcome identity and recorder non-interference

Every execution produces canonical substantive hashes for:

```text
candidates
verification decisions and reasons
promotions
publication decisions
premerge decisions
```

Each case and mode is run with a null recorder and a real recorder. The five
substantive hashes must be byte-identical. Recorder disagreement invalidates
the experiment; it is never reported as treatment movement. Recorder order is
counterbalanced by case, and each execution receives an isolated empty cache so
JIT or cache warming cannot be attributed to the recorder.

## Quality metrics

Counts are reported before ratios. A zero denominator produces
`undefinedRatio`, never a flattering zero or one.

```text
cases
planted findings
candidates
candidate true positives
candidate false positives
candidate false negatives
candidate precision

verified / rejected / inconclusive / unavailable
promoted
published / withheld
published true positives
published false positives
published false negatives
published precision
published recall
```

Two paired treatment effects are primary:

```text
TP recovered because repository context existed
  expected finding published in TREATMENT but not CONTROL

FP introduced because repository context misled reasoning
  unwanted finding published in TREATMENT but not CONTROL
```

### Causal family attribution

Exposure and outcome attribution are separate:

- `exposed` means the selected context carried that family's provenance.
- `mattered` is evaluated for the same matched `goldId` or the same unmatched
  false-positive semantic identity. Its per-outcome state
  `(candidate present, verification decision, promoted, published)` must differ
  between full treatment and the leave-one-family-out ablation.

An outcome is attributed to `none`, one named family, or `multiple`. If full
treatment differs from control but no single ablation changes the output, the
outcome is `multiple` because the families are redundant or interactive. The
harness must not choose attribution from whichever context item appears nearest
to a finding. Run-level hash differences and diagnostic-only changes trigger
investigation but never establish causal quality attribution.

The named families are:

```text
structural_index
binding
test_relationship
config_governance
instruction_governance
```

`structural_index` covers indexed declaration selection independent of binding
edges. `binding` covers binding-derived referenced symbols and callers.

## Context metrics

Context is counted both before and after selection:

```text
offered items / estimated tokens
scored unique items / estimated tokens
selected items / estimated tokens
omitted items / estimated tokens
truncated items / estimated tokens
duplicates suppressed
```

Counts are split by this fixed reason taxonomy:

```text
declaration
caller
test
config
instruction
coverage
changed_source
other
```

The exhaustive production-to-report mapping is version 1:

```text
changed_hunk                                      -> changed_source
containing_symbol                                 -> declaration
indexed_declaration                               -> declaration
referenced_symbol                                 -> declaration
caller                                            -> caller
associated_test                                   -> test
configuration                                     -> config
repository_instruction, path_instruction          -> instruction
instruction_coverage                              -> coverage
prior_finding, git_history                        -> other
```

The exhaustive L-family mapping also uses provenance:

```text
indexed_declaration + repository_index provenance -> structural_index
referenced_symbol/caller + repository_index        -> binding
associated_test + repository_index                 -> test_relationship
configuration + configuration_facts               -> config_governance
instruction reasons + instruction_facts           -> instruction_governance
coverage + instruction_coverage                    -> instruction_governance
all established direct/legacy source combinations -> none
```

Any new reason or unrecognized reason/provenance combination invalidates the
run; it may not silently become `other`. Offered, scored, selected, omitted,
and family totals must reconcile to their detailed rows.

`duplicates suppressed` is `offered candidates - scored candidates` for the
same planner invocation. It is not inferred from repeated text after assembly.

Context labels use one of `whole_artifact`, `line_range`, or exact `content`
selectors. Useful selected bytes are only the supplied bytes intersecting a
required selector; overlapping selectors are deduplicated. A whole selected
file is not wholly useful merely because it contains one required symbol.
Irrelevant selected bytes are supplied bytes intersecting a forbidden selector.
Unlabelled bytes are reported separately and are not silently graded useful or
irrelevant.

Offered and scored sizes use the original candidate estimate. Selected sizes
use an estimate over `suppliedContent`. Truncation reports original, supplied,
and dropped estimated tokens separately. Estimates are characters divided by
four and are never called provider tokens or used as monetary cost.

Primary context efficiency:

```text
useful selected estimated tokens / all selected estimated tokens
```

An absent selected-token denominator is undefined.

## Incremental economics

Every incremental pair records the production stats:

```text
modules total / retained
references recomputed / retained
bindings recomputed / retained
direct invalidations
dependency invalidations
incremental attempted / succeeded
full rebuild fallback
```

Record counts do not imply speed. Wall-clock measurements use a monotonic clock
and compare full rebuild with the complete `updateRepositoryIndex` operation
for the same H2 revision, including any attempted work and fallback rebuild.

```text
warmups per path       5
measured runs          20
execution order        alternating full/incremental, then reversed
reported duration      n, median, p95, max
reported speedup       median of paired (full / incremental) ratios
```

Timing is local deterministic evidence, not a production latency prediction.
The primary distribution is intention-to-treat over every scheduled attempt.
A fallback duration includes attempted incremental work plus its fallback full
rebuild and remains in the primary denominator. Failures remain counted and are
reported as failed paired observations, never silently dropped. A secondary
successful-incremental distribution is diagnostic only. Independently pooled
full and incremental medians may not be divided to claim speedup.

## Analyzer-input identity metrics

This experiment measures the production `analyzerCacheKey` and its lookup
identity in `apps/review-worker/src/analysis.ts`, not the lower-level cluster
`fingerprintCluster` execution cache. Each cache pair has a gold expectation
independent of the produced key:

```text
reuse_expected
invalidation_expected
```

The report is a confusion matrix:

```text
true cache reuse          expected reuse, key reused
unnecessary invalidation  expected reuse, key changed
correct invalidation      expected invalidation, key changed
dangerous false reuse     expected invalidation, key reused
```

`dangerous false reuse` must be zero. Config-only, instruction-only,
selection-only, and unchanged-input reuse pairs are reported separately so one
easy category cannot hide another.

Every expectation and semantic rationale is committed before either key is
computed. Gold may not be derived from key equality, context digest, cached
output, or current behavior. Reuse pairs preserve analyzer-visible semantic
input and the repository isolation domain while varying an authored nuisance
dimension such as traversal order. Invalidation pairs change exactly one named
semantic dimension.

## Pre-registered interpretation and stop conditions

These rules are fixed before results:

1. Any dangerous false cache reuse fails L.5 immediately.
2. Any recorder-induced substantive hash change invalidates the experiment.
3. Any control/treatment equivalence-hash mismatch invalidates that pair.
4. If published precision drops, L.5 does not claim improvement even if recall
   rises.
5. If published recall does not rise and precision is unchanged, L.5 reports no
   demonstrated quality benefit. Architecture is not evidence of benefit.
6. If treatment median selected tokens per case exceed control by more than
   `2x`, any quality gain is classified as a context-cost escalation requiring
   planner investigation.
7. If one family introduces more published false positives than true positives
   it recovers, narrow that family's planner consumption before adding features.
8. Incremental execution is called economically useful only if at least `90%`
   of scheduled attempts succeed incrementally and the primary intention-to-
   treat median paired ratio shows incremental duration at least `10%` below
   full rebuild. Otherwise do not optimize invalidation width yet.
9. If repository intelligence changes no quality metric, retain correct facts
   but do not assume the current planner consumption is worthwhile.
10. L.5 does not optimize production behavior after seeing results. Any
    follow-up change is a separately specified checkpoint with a new baseline.

## Required report

The final report includes all per-case rows, not only aggregates, plus:

```text
control/treatment equivalence audit
recorder non-interference audit
quality confusion matrices
TP recovered and FP introduced, with causal attribution
context counts and efficiency by reason and family
incremental stats and wall-clock distributions
cache-identity confusion matrices
every invalid/excluded run and why
the stop-condition verdicts, including negative conclusions
```

No metric may be removed, renamed, or reinterpreted after a result is observed
without invalidating the run and incrementing the experiment schema version.
