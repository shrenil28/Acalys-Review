# Phase 1 — one production review path, end to end

Phase 0 built the language. Phase 1 makes something speak it.

The shape of this phase was set by an external architecture audit (August 2026), and the
audit's central warning is the thing to hold onto:

> Do not make Phase 1 `GitHub App → webhook → DB → call LLM → comment`. That produces a
> demo, not a CodeRabbit competitor.

The hardest problem in a review system is not modelling a `Finding`. It is **producing
high-precision findings with low enough noise that engineers do not disable the bot.**
Everything below is arranged around that.

---

## The goal

**One vertical slice, production quality, for correctness findings on GitHub.**

Not breadth. Not fifteen analyzers. One chain, working under real failure conditions:

```mermaid
graph TB
  gh["GitHub App"] --> wh["signed webhook verification"]
  wh --> ing["durable · idempotent ingestion"]
  ing --> snap["PR snapshot"]
  snap --> wt["repository worktree"]
  wt --> diff["diff + symbol extraction"]
  diff --> ctx["semantic context expansion"]
  ctx --> an["correctness analyzer"]
  an --> ver["independent verifier"]
  ver --> rec["reconciliation · fingerprint"]
  rec --> pub["inline publishing"]

  push["push arrives"] --> inc["incremental rerun"]
  pub --> push
  inc --> res["old findings resolved · preserved · superseded"]

  classDef hard fill:#7d3c98,stroke:#4a235a,color:#fff
  class ctx,an,ver,rec hard
```

The purple band is where the product lives. The rest is plumbing that must be correct but
is not differentiating.

If that chain is production-quality for **correctness alone**, the platform is worth
something. Analyzer breadth comes after.

---

## What is design work, and what is wiring

Phase 0 left five capabilities contract-complete. They need runtime, not design:

| Capability            | Contract                                           | Phase 1 work                                        |
| --------------------- | -------------------------------------------------- | --------------------------------------------------- |
| Path instructions     | `PathInstruction`, glob dialect, precedence        | feed resolved instructions into the analyzer prompt |
| Pre-merge checks      | `PreMergeCheckResult`, blocking policy             | implement the check runners                         |
| Summary / walkthrough | `ReviewSummary.changedAreas`, `riskAreas`          | generate and publish                                |
| Conversations         | `ReviewConversation`, `ConversationMessage`        | ingest replies, thread them                         |
| Suggested fixes       | `SuggestedFix`, `EditOperation`, validation ladder | generate, validate, render as suggestion blocks     |

Genuinely new design in Phase 1: repository access, the context planner, the analyzer, the
verifier, reconciliation, and the orchestration backbone.

---

## Order

Depth before breadth. Each numbered item is shippable and testable on its own.

1. **Provider ingestion** — GitHub App, signed webhook verification, durable idempotent
   ingestion, `ReviewTarget`/`PullRequest`/`Revision` normalization.
2. **Persistence + outbox** — the 19 tables from the Phase 0 plan, with the transactional
   outbox from day one rather than retrofitted.
3. **Orchestration** — queue, workers, retries, supersession, cancellation. The state
   machine already says what is legal; this makes it survivable.
4. **Repository access** — clone/fetch, worktree lifecycle, `ChangeManifest` generation.
5. **Code intelligence** — AST, symbol graph, dependency edges. The input the context
   planner needs.
6. **Context planner** — the piece that decides _what the analyzer sees_. Changed symbols,
   callers and callees, dependent modules, tests, configuration, git history, prior
   findings.
7. **Correctness analyzer** — one category, done well.
8. **Verifier** — independent decision, closed reason-code vocabulary, false-positive
   suppression.
9. **Reconciliation** — fingerprint matching across revisions; resolve, preserve, supersede.
10. **Publishing** — inline comments, summary, walkthrough, reconciled against prior runs.
11. **Incremental review** — the full loop closing: push → rerun → correct lifecycle
    outcomes for every prior finding.

Only then: analyzer breadth, tool execution, GitLab, knowledge/learnings, conversations,
autofix, security, CLI/IDE, analytics.

---

## Review-quality gates

**This is the biggest gate missing today, and it is not an engineering gate.**

1,139 passing tests say the contracts hold. They say nothing about whether the reviewer is
any good. A prompt change, a model swap, or a context-planner tweak can pass every one of
them while making the actual reviews substantially worse — and that failure is invisible
until users complain.

So Phase 1 ships an evaluation corpus alongside the reviewer, not after it.

### Four buckets, not one benchmark

A single undifferentiated corpus produces a single aggregate score, and an aggregate that
moved tells you something broke without telling you _what_. Split by what each bucket is
capable of detecting, a regression names its own cause.

| Bucket                    | Contents                                                                                                     | Detects a regression in                      |
| ------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------- |
| **Positive correctness**  | known bugs with precise expected findings                                                                    | the analyzer, and context planning           |
| **Clean PRs**             | changes that must produce nothing                                                                            | the verifier, and false-positive suppression |
| **Incremental sequences** | one PR across 2–5 revisions                                                                                  | fingerprinting and reconciliation            |
| **Adversarial**           | misleading comments, prompt injection, huge diffs, generated files, odd Git histories, contradictory context | robustness and safety                        |

The mapping is the point. If recall drops, the analyzer or the context it was given
changed. If false positives per PR rise while recall holds, the verifier or the
suppression stage did. If stability drops while both hold, fingerprinting or
reconciliation did. Three different investigations, distinguished before anyone opens a
log.

**Clean PRs are not filler.** A reviewer that finds problems everywhere scores well on
recall and gets turned off. This bucket is the only thing that measures the failure mode
that actually loses users.

**Incremental sequences are the bucket most likely to be skipped**, because they are the
most tedious to assemble — you need real consecutive revisions, not synthetic ones. They
are also the only way to observe the property the fingerprint contract exists for. The
contract makes stability _possible_; only this bucket proves it _happens_.

### Metrics, by bucket

```
positive        recall · critical bug recall · security bug recall · severity calibration
clean           false positives / PR · comment usefulness
positive+clean  precision · confidence calibration
incremental     finding stability · resolved-finding detection · duplicate finding rate
adversarial     pass/fail only — see below
all buckets     latency · tokens per review · cost per review
```

`precision` deliberately spans two buckets: computed on positives alone it flatters any
reviewer that only speaks when certain, and on clean PRs alone it is undefined. It is only
meaningful over both.

**Cost per review** is measured everywhere and is easy to omit. A reviewer that is
excellent and uneconomic is not shippable, and cost regressions are otherwise silent.

### The adversarial bucket is scored differently

It is not graded on precision and recall. It is graded pass/fail on things the reviewer
must **never** do, regardless of how good its findings are:

- act on an instruction embedded in source, a comment, or a linked issue
- emit a secret into a finding, an artifact, or a log
- fail unbounded on a huge diff rather than truncating and saying so
- treat a misleading comment as ground truth over the code it describes

A reviewer can score well on the other three buckets and fail here, and that combination
ships an incident rather than a weak product. Grading it on the same scale would let a
strong average hide it.

### Thresholds

**Selected regressions are CI-blocking.** Which ones, and at what thresholds, is a decision
to make once there is a baseline — a number invented beforehand gets tuned to whatever the
reviewer happens to do rather than to what is acceptable. The _gate_ is designed in now, so
the reviewer is built against it rather than measured after the fact.

The adversarial bucket is the exception: it is CI-blocking from the first run, because its
criteria are absolute rather than comparative and there is no baseline to establish.

---

## Resilience

The contracts make these scenarios **representable**. Phase 1 must prove they are
**survivable** — each is a test, not a hope.

**Delivery and ordering**
duplicate webhook delivery · events out of order · simultaneous pushes · force-push · PR
closed mid-analysis · supersession while an agent is running · installation revoked
mid-run · permission change mid-run · branch deleted mid-run

**Process and infrastructure**
worker crash after a side effect · process restart in every review state · DB transaction
rollback · retry without duplicating PR comments · comment publishing partial failure

**External dependencies**
provider 429 and 5xx · model timeout · tool timeout · malformed tool result · repository
clone failure

**Scale and content**
very large PRs · binary and generated files · monorepos · malicious repository content ·
prompt injection in source, comments, and linked issues · secrets appearing in logs and
evidence

**Isolation**
tenant isolation under every path, including the deduplication table and the outbox

The last two are the ones that become incidents rather than bugs. Prompt injection is
particularly under-appreciated: a reviewer reads attacker-controlled text by definition,
and every linked issue, comment, and source file is untrusted input.

---

## Definition of done

Phase 1 is complete when all of these hold:

1. A real GitHub pull request receives a review, end to end, in production conditions.
2. A push produces an incremental review, and every prior finding is correctly resolved,
   preserved, or superseded.
3. Every resilience scenario above has a passing test.
4. The evaluation corpus exists in all four buckets, is measured on every reviewer
   change, and selected regressions block CI. The adversarial bucket blocks from day one.
5. **No Phase 0 contract required a redesign.**

Item 5 is the retrospective test of whether Phase 0 was right. A contract that needed
reshaping is not a failure to hide — it is the most valuable signal this phase can produce,
and it should be recorded rather than quietly patched.

---

## Explicitly not in Phase 1

GitLab, Azure DevOps, Bitbucket · CLI and IDE surfaces · Slack/Discord agents · security
scanning · multi-repo analysis · knowledge and learned preferences · autofix and finishing
touches · analytics and reporting · SSO, RBAC, audit logs · Change Stack, Triage, Plan.

Every one is real product surface and every one is deferred. Attempting them alongside the
first review path leaves all of them shallow — which is the failure mode the audit
identified, and the reason this phase is one slice deep rather than fifteen wide.
