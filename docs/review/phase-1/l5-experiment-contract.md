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

Four treatment ablations run for attribution only:

```text
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
verifier policy version
publication policy
premerge policy
context token budget
```

The control/treatment pair must have the same equivalence hash. Mode and
ablation identity are hashed separately and must differ. A mismatch invalidates
the pair rather than becoming an outcome.

## Fixed corpus contract

The corpus is committed before the first aggregate report is produced. Every
case states why each expected finding and required/forbidden context item is
correct. The minimum composition is:

```text
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

At least one config and one instruction case keep changed source bytes stable
across their identity pair. At least one instruction pair is a deletion. At
least one outage case retains a known positive while coverage is incomplete.

Cases may reuse the existing planner and analyzer corpora, but their L.5 gold
labels are copied into the frozen L.5 corpus rather than inferred from current
production output.

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
the experiment; it is never reported as treatment movement.

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
- `mattered` means the full-treatment substantive output differs from the
  corresponding leave-one-family-out ablation.

An outcome is attributed to `none`, one named family, or `multiple`. If full
treatment differs from control but no single ablation changes the output, the
outcome is `multiple` because the families are redundant or interactive. The
harness must not choose attribution from whichever context item appears nearest
to a finding.

The named families are:

```text
binding
test_relationship
config_governance
instruction_governance
```

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

`duplicates suppressed` is `offered candidates - scored candidates` for the
same planner invocation. It is not inferred from repeated text after assembly.

Useful selected facts are selected items satisfying a corpus `required`
label. Irrelevant selected facts are selected items satisfying a corpus
`forbidden` label. Unlabelled context is reported separately and is not silently
graded useful or irrelevant.

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
and compare full rebuild with incremental update for the same H2 revision.

```text
warmups per path       5
measured runs          20
execution order        alternating full/incremental, then reversed
reported duration      n, median, p95, max
reported speedup       median full / median incremental
```

Timing is local deterministic evidence, not a production latency prediction.
Any failed or fallback incremental run is counted and excluded from no timing
denominator.

## Analyzer-input identity metrics

Each cache pair has a gold expectation independent of the produced key:

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
8. Incremental execution is called economically useful only if its median is at
   least `10%` lower than full rebuild on successful pairs. Otherwise do not
   optimize invalidation width yet.
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
