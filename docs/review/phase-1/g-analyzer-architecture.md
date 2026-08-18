# P1-G — the analyzer architecture, frozen conceptually

Everything before this checkpoint decided _whether_ a review happens and whether
it survives a crash. This decides whether it is worth reading.

The shape, and the thing it is deliberately not:

```
                      NOT THIS
        diff + lots of context → giant prompt → model → comments

                      THIS
                 P1-F context planner
                          │
                          ▼
                AnalysisContextSnapshot
                          │
                   ┌──────┴──────┐
                   │             │
             cheap triage   deterministic evidence
                   │        (compiler · lint · tools)
                   └──────┬──────┘
                          ▼
                    risk clusters
                          │
             ┌────────────┼────────────┐
             ▼            ▼            ▼
          deep pass    deep pass     skip
             └──────┬─────┘
                    ▼
             CandidateFinding[]   ← may be empty, and often should be
                    │
                    ▼
              P1-H verifier (independent)
```

The first shape works in a demo and becomes expensive and noisy on a real
repository. Its failure mode is not "misses bugs" — it is "costs $8 a pull
request and gets muted in week two".

---

## 1. The unit of analysis is a risk cluster, not a file

A file is a storage boundary. It is not the boundary of a defect.

```
controller.ts changed
    │ calls
auth-service.ts
    │ depends on
permissions.ts
    │ tested by
auth.test.ts
```

Four analyzer invocations over four files means each one reasons with a quarter
of the picture and pays for the shared context four times. One cluster:

```
RiskCluster {
    changed symbols        what the author actually wrote
    relevant hunks         the lines, with their containing declarations
    callers / callees      the contract surface the change is judged against
    contracts / interfaces where the requirement is stated
    tests                  where intent is stated more reliably than in prose
    instructions           what this repository counts as a defect
    tool observations      what the compiler and linters already established
}
```

This is what buys cross-file correctness and fewer duplicated tokens at the same
time. It is also the unit that incremental review invalidates — see §7.

**A cluster is a semantic unit, so two changed files that share no symbols are
two clusters, and one changed file touching two unrelated subsystems is also
two.** Grouping by file would produce neither.

---

## 2. Triage allocates budget. It never produces findings.

A cheap pass classifies each cluster approximately:

```
risk · novelty · blast radius · complexity
contract sensitivity · test coverage impact · security sensitivity
```

and that classification decides only _how much_ is spent:

```
low        no deep invocation, or a lightweight pass
medium     normal reasoning budget
high       expanded context + deep reasoning
critical   deep reasoning + tool evidence + mandatory verification
```

**The triager must never emit a CandidateFinding.** The moment a budget
mechanism can publish, it becomes a second, worse reviewer whose output nobody
tuned — and its cheapness, the entire reason it exists, becomes the reason its
findings are bad. Enforced by type: triage returns an allocation, not findings.

---

## 3. Correctness only, with an internal taxonomy

The public category stays `correctness`. No security, performance,
maintainability, style, testing or architecture in P1-G.

But `correctness recall dropped 8%` is not actionable, so analyzers label
findings with an internal family:

```
control flow        wrong branch, missing branch, wrong early return
state               invalid transition, stale state, inconsistent mutation
data flow           wrong value propagated, lost value, bad transformation
nullability         missing null / undefined handling
boundary            off-by-one, range, truncation
error handling      swallowed error, wrong retry, wrong failure classification
resource lifecycle  forgotten cleanup, double close, leak
concurrency         race, TOCTOU, stale observation
persistence         non-atomic write, wrong transaction semantics
api contract        caller and callee disagree
compatibility       a changed assumption breaks an existing consumer
```

These are **analyzer and eval diagnostics, not Phase 0 taxonomy values**. They
never reach a DTO. What they buy is the difference between

```
correctness recall −8%
```

and

```
transaction bugs   unchanged
boundary bugs      unchanged
api contract bugs  −31%     ← investigate here
```

---

## 4. A finding must explain itself, or it does not exist

An analyzer may not emit a claim it cannot connect to the change. The required
structure:

```
claim               what is wrong
changed anchor      the line the author wrote that causes it
causal chain        how that line produces the failure
trigger             the input or state required to reach it
consequence         what the reader loses when it happens
evidence            what establishes each step
counterfactual      would this exist without the change?
confidence          derived from evidence, never asserted
```

If the causal chain cannot be written, the finding is suppressed. Not
downgraded, not emitted with low confidence — **suppressed**. A reviewer that
says "this might fail" has transferred its uncertainty to the reader, who now
has to do the analysis that was the reviewer's job.

The counterfactual matters most. `not_caused_by_change` already exists as a
verification outcome; P1-G should not spend P1-H's budget on findings it could
have recognized as pre-existing itself.

**Silence is a first-class successful result.** `CandidateFinding[]` includes
`[]`, and these never become correctness findings:

```
uncertain · stylistic · minor preference · generic best practice · possible optimization
```

At this stage, saying nothing beats saying something weak. A reviewer that feels
obliged to produce one observation per cluster destroys the clean-PR score, and
the clean-PR score is what decides whether anyone leaves it enabled.

---

## 5. Never spend reasoning on facts something else already proved

The compiler knows `property does not exist`. The linter knows the unused
import. Rediscovering those with an expensive pass is the most common way an
LLM reviewer becomes uneconomic.

```
RiskCluster
├── source context        ← planner
├── structural graph      ← code intelligence
├── compiler evidence     ← deterministic
├── test evidence         ← deterministic
├── linter evidence       ← deterministic
├── static analysis       ← deterministic
└── model reasoning       ← only for what the others cannot establish
```

Deterministic producers answer _what is true_. Reasoning answers _why it
matters, whether this change caused it, what breaks downstream, and what the
repair is_. The first analyzer in this repository —
`acalys.correctness.async-completion` — is deliberately a deterministic producer
for exactly this reason: it establishes facts, cheaply, that reasoning would
otherwise pay to rediscover.

Not 57 tools in P1-G. But the seam is built now, because retrofitting evidence
into a prompt-shaped analyzer means rewriting it.

---

## 6. Budget is allocated before invocation, never truncated after

The planner already produces ranked candidates with reasons. Per cluster:

```
mandatory     changed hunk · containing symbol · repository instructions ·
              the direct contract or interface
optional      caller · callee · test · history · distant dependency ·
              prior findings          ← consumed in score order until spent
```

```
BAD    A + B + C + D + E → concatenate → over limit → slice the string
GOOD   A, B mandatory; C .91; D .83; E .27 → budget covers A+B+C+D
       → E recorded as an omission with its reason
```

Slicing a concatenated prompt destroys whichever item happened to be last, which
is a choice nobody made and nobody can review.

**Deduplication is aggressive and run-scoped.** One interface referenced by five
clusters is stored once by content digest and referenced, not retrieved,
re-parsed, re-ranked and re-serialized five times. Same symbol, same revision,
same representation, same instruction set → same canonical object.

---

## 7. Two identities, and conflating them invalidates the eval

```
AnalysisContextSnapshot.digest        model-INDEPENDENT
    change identity · resolved instructions · selected context

analyzer output cache key             model-DEPENDENT
    change identity
  + context snapshot digest
  + resolved instruction/config digest
  + analyzer id and version
  + prompt / procedure version
  + model and provider identity
  + inference configuration
```

The snapshot stays model-independent so the same context can be run against two
models and the difference attributed to the model. The cache cannot be keyed on
it alone: change the model and the cache would serve the previous model's
findings, and every quality number after that point would be measuring a
model that never ran.

---

## 8. Incremental is native, not an optimization added later

The question is not _what files are in the diff_. It is:

```
which semantic clusters changed since the previous revision?
```

```
revision 1    clusters A B C D
revision 2    touches B
              → invalidate B
              → invalidate C if it depends on B's changed surface
              → reuse A and D
```

Rerunning every cluster because the head SHA moved is what makes an incremental
review indistinguishable from a full one, and it is where the fingerprint, code
graph and context-snapshot work start paying for themselves.

---

## 9. Fan-out is capped, and degradation is observable

```
12 changed symbols × 8 dependencies × 4 hypotheses × deep pass
```

is how a repository-aware reviewer accidentally issues hundreds of calls.

```
max risk clusters · max concurrent deep analyses · max context tokens
max reasoning calls · max retries · max token or cost budget
```

Bounded parallelism, not maximum: independent clusters run concurrently through
N workers sized to provider limits, never `Promise.all(87)`.

When a limit is reached the review **records the omission and degrades
visibly**. It does not silently analyze half the pull request and present the
result as a complete review. The quality report has to know a review was
budget-constrained, or every metric computed from it is wrong in an unknown
direction.

A model or tool failure is a bounded failure. It never becomes a fabricated
finding.

---

## 10. The verifier stays uncontaminated

P1-H receives:

```
CandidateFinding + its evidence + independently assembled verification context
```

and never:

```
the analyzer's hidden reasoning · its prompt · "the analyzer is 97% sure"
```

A verifier shown the analyzer's confidence is an agreement machine. The Phase 0
split between `CandidateFinding` and `ReviewFinding` exists to make this
enforceable rather than hoped for.

---

## 11. The gate is the dashboard, not the test count

1,526 engineering tests say the platform works. They say nothing about whether
the reviewer is good.

| Metric                                     | Diagnoses                                |
| ------------------------------------------ | ---------------------------------------- |
| correctness recall                         | analyzer capability                      |
| precision                                  | candidate quality                        |
| false positives per clean PR               | noise — the number that decides adoption |
| required-context recall                    | the planner, separately (P1-F.2)         |
| candidate → verifier rejection rate        | analyzer over-generation                 |
| findings per 1k changed LOC                | chattiness                               |
| tokens per changed LOC                     | context efficiency                       |
| **tokens per verified actionable finding** | economic viability                       |
| latency p50 / p95                          | user experience                          |
| cost per review                            | commercial viability                     |
| cache hit rate                             | incremental efficiency                   |
| clusters deeply analyzed / total           | budget allocation                        |
| context utilization                        | planner efficiency                       |

`tokens per verified actionable finding` is the one that catches both failures a
single metric would miss: a cheap reviewer producing garbage, and an excellent
reviewer costing more than the bug it found.

> Do not optimize for comments produced. Optimize for verified actionable bugs
> per unit of developer attention and compute.

### How to read the dashboard while the corpus is small

A perfect score over seventeen cases means **the harness works**. It does not
mean the reviewer has perfect precision and recall, and recording it as though
it did would mislead exactly the person who reads it next. The current status is:

```
eval framework green  /  baseline corpus green
```

Corpus growth is the next target, and the useful cases are the ones where the
obvious implementation fails rather than more of what already passes:

```
same symptom, different root cause
misleading nearby code
declaration present but semantically incompatible
caller across a package or module boundary
generic or overloaded async declarations
nested promise chains
callbacks reached through an alias
clean code that closely resembles a known positive
```

Those pressure the architecture. More rules only pressure the rules.

### Gates for wiring the engine into the worker

The engine is only trustworthy once it runs inside the real lifecycle, so these
are requirements on the integration rather than on the analyzers:

```
one ReviewRun          → one immutable revision/context input
cancellation           → the analyzer stops starting new work
superseded run         → results cannot publish
engine failure         → the run takes the existing legal failure path
retry                  → no duplicated findings or comments
same revision + config → deterministic analyzers produce stable output
budget exhaustion      → partial analysis is explicit, never silently complete
```

And the one that keeps reproducibility possible at all:

> **No stage reconstructs domain state independently of the worker's canonical
> snapshot.** The worker hands the engine one authoritative input bundle;
> analyzers never re-fetch provider or repository state for themselves.

The layering stays:

```
ReviewRun → review-engine → CandidateFinding[] → verification → ReviewFinding[]
          → publisher projection
```

`FindingView` is a **presentation** projection and nothing else. In particular
the verifier never reads it: verification needs the canonical finding and its
evidence, not UI-shaped prose.

---

## Definition of done

```
clean PR                          → usually []
real correctness defect           → precise causal CandidateFinding
cross-file defect                 → found using semantic context
same defect moved within a file   → stable fingerprint
irrelevant large dependency       → consumes no deep-analysis budget
same push replayed                → identical analysis identity
second revision, unrelated cluster→ unchanged clusters reused
budget exceeded                   → graceful and observable degradation
model or tool failure             → bounded failure, never a fabricated finding
```

---

## Extension points, built now, filled later

The analyzer consumes an extensible snapshot rather than `diff + nearby source`:

```
AnalysisContextSnapshot · Evidence[] · ResolvedInstruction[] · ToolObservation[]
```

so that repository-wide context, path instructions, team learnings, linked
issues, CI results, external tool output, conversations and suggested fixes are
additions rather than rewrites. None of them are implemented in P1-G.

---

## Phase 0

Additive. Risk clusters, triage allocations, correctness families and tool
observations are Phase 1 analysis concepts. `CandidateFinding`, `Evidence`,
`Verification` and the finding lifecycle already carry what they need. Phase 0
remains frozen.
