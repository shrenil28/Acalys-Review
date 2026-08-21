# Phase 1 status

```
P1-A                  GitHub normalization                      ✓
P1-B                  GitHub App authentication                 ✓
P1-C                  secure durable webhook ingestion          ✓
P1-D                  claims · leases · retries · concurrency   ✓
P1-E.1                delivery → queued ReviewRun               ✓
P1-E.2                deterministic lifecycle + crash recovery  ✓
P1-E.3                provider publication / reconciliation     ✓ LIVE PROVEN
P1-F                  code intelligence + context planner       ✓
P1-F.2                planner eval + committed baseline         ✓
P1-G                  correctness analyzer                      ✓
P1-H                  independent deterministic verifier        ✓
P1-I                  durable trust funnel → publication        ✓
P1-PUBLISH-SURFACES   design checkpoint                         recorded
P1-VERIFY-CONCURRENCY design checkpoint                         recorded
P1-J                  deterministic quality + execution baseline ✓
P1-INFRA-POSTGRES     one container, database per suite         ✓
P1-K                  frontend production boundary              ✓
P1-GATE-INTERLOCK     mutation session guards every gate        ✓
P1-L.1                canonical repository index + live witness  ✓
P1-L.2                references, bindings, import-export         ✓
P1-L.3                incremental invalidation + rebuild oracle   ✓
P1-L.4.1              code-to-test, from bindings                ✓
P1-L.4.2              code-to-config governance                   ✓
P1-L.4.3              code-to-instruction                        ✓
P1-L.5                quality + economics measurement            ✓ CLOSED (NEGATIVE BENEFIT)
P1-M.1                miss attribution + executable gate       ✓ FROZEN
P1-M.2                configuration-sensitive type safety         next
```

`P1-M.1` freezes review-capability expansion premises without changing
production behavior. All 10 P1-L.5 false negatives died at candidate
generation: the analyzer emitted nothing, so verification and policy never
ran. Required repository evidence was selected in every case. The frozen M.1
corpus preserves the 12-case historical baseline, adds eight visible
development cases and eight sealed holdout cases across the eight observed
semantic families, and retains the sole naturally observed analyzer false
positive as an append-only replay. P1-M closes only at at least 8/12 historical
published recall, at least 4/8 development and holdout published recall, 100%
published precision, and zero natural-FP publication. See
[m1-miss-attribution.md](./m1-miss-attribution.md) and
[m1-capability-contract.md](./m1-capability-contract.md).

`P1-L.5` is closed from the report generated at source freeze `7684687`. Review
quality was unchanged: 2/12 published recall and 100% published precision in
both control and treatment, with zero TP recovered and zero FP introduced.
Treatment selected 30.2% more estimated tokens in aggregate and its context
efficiency declined slightly. Cache identity passed all 8/8 authored pairs with
zero dangerous false reuse. Incremental indexes were equivalent and succeeded
80/80 times, but the `0.894x` median paired speedup failed the economic stop
condition. The conclusion is deliberately negative: retain correct facts, do
not claim current planner consumption improves review quality, and do not
optimize invalidation width yet. Full evidence is in
[l5-report.md](./l5-report.md) and [l5-report.json](./l5-report.json).

The final execution followed production-runner
commit `2e42734` and execution-command commit `91d527f`, after 94 focused L.5
tests, full repository typecheck, and 21/21 semantic kills in mutation band
169-189. The first execution from `7708e60` was invalidated before scoring or
report creation because its direct-source attestation observed post-dedup
offers rather than the explicit pre-competition producer trace. The next
attempt from `68378e6` was also invalidated before scoring because its CLI
resolved stale package build output; the canonical command now builds its
frozen package dependencies first. No result from either attempt is retained.
Corpus v2 separately corrects a pre-result cache premise: authored reuse pairs
preserve production head identity while varying traversal order only. The
runner compares null repository intelligence with the frozen L.1-L.4
production path on byte-identical corpus inputs, measures quality, context
efficiency, incremental wall-clock economics, and cache correctness, and uses
explicit family ablations for causal attribution. Dangerous false cache reuse
and recorder interference are hard failures. See
[l5-experiment-contract.md](./l5-experiment-contract.md).

`P1-L.4.3` is closed at source freeze `f50f7f4`. Exact `AGENTS.md` artifacts
are discovered as revision-bound facts, applied with segment-aware plural
scope, analyzed with independent precedence and trust, and carried through the
production planner into context and analyzer identity. Incomplete discovery is
explicit non-authoritative context rather than negative absence. Add, delete,
same-selected-text, and partial-outage witnesses preserve independent
`RepositoryIndex`, `ConfigFacts`, and `InstructionFacts` identities. Closing
evidence: 2,164 tests executed with 0 skipped under Postgres-required `verify`;
167/167 mutants detected, with 166 semantic assertion kills, the one
pre-existing setup kill `#58`, 0 survivors, and 0 invalid. See
[l4-3-instruction-governance.md](./l4-3-instruction-governance.md).

`P1-L.4.2` is closed at `5b31de7`. TypeScript's project parser establishes
membership; Acalys keeps source governance, option inheritance, and project
references distinct, and carries incomplete or unusable fact dimensions
without turning them into negative absence. A production witness proves that
a config-only change leaves the repository-index serialization and digest
unchanged while changing selected context and analyzer identity. Closing
evidence: 2,087 tests executed, 0 skipped, under Postgres-required `verify`;
152/152 mutations detected, with 151 semantic assertion kills, the one
pre-existing setup kill `#58`, 0 survivors, and 0 invalid. See
[l4-2-config-governance.md](./l4-2-config-governance.md).

`P1-VERIFY-CONCURRENCY` is recorded rather than built, for the same reason
`P1-PUBLISH-SURFACES` is. P1-I gives one invocation **result-persistence**
idempotency; it does not give it **execution-concurrency** semantics, so two
workers may both execute one recovered command. A deterministic verifier cannot
disagree with itself, so the failure does not arise yet — but a model-backed one
will, and then `ON CONFLICT (invocation_id)` means arrival order decides which
conclusion the product stands behind. The detection half is built
(`AttemptResultConflict`); the single-flight lease is not, and building it
against a verifier that cannot exercise it would produce a code path that runs
rarely. See [verification-execution-concurrency.md](./verification-execution-concurrency.md).

`P1-PUBLISH-SURFACES` is recorded rather than built: the "one summary comment,
edited across pushes" requirement exposed a real semantic distinction — an
immutable `PublicationEffect` is not a mutable `PublicationSurface` — and it is
written down before anything depends on conflating them. Additive, like
P1-CONTEXT. See [publication-surfaces.md](./publication-surfaces.md).

`P1-GATE-INTERLOCK` is built. It closed a hole the
P1-K fix wave exposed. `.git/acalys-mutation-session` (K.5c) makes a foreign
`test:ci` refuse to start against a tree a mutation harness is actively
mutating. It guards exactly one gate. Every other repo-wide gate —
`typecheck`, `lint`, `format`, `depcruise`, `build`, `schemas`, export
conformance — still reads the mutable worktree unguarded, so an
independently launched gate can report a failure caused by a planted
mutation rather than by the code. That produces a false failure, and the
worse case is the inverse: a gate that passes _because_ it ran against a
mutated tree, recorded as evidence the tree is clean.

The rule, now enforced: while a mutation session is active, only
mutation-harness-owned child commands (nonce-authorized) may inspect the
worktree; every independently launched repo-wide gate refuses with the
session's identity in the message. All nine gates route through one door,
`scripts/run-gate.mjs`, and a structural test asserts `verify` runs
protected gates and nothing else. Stale locks are reclaimed only on
positive ownership proof — reboot, absent pid, or recycled pid — never on
age. See [gate-interlock.md](./gate-interlock.md).

P1-F.2 lands before the analyzer on purpose. Without planner metrics, a P1-G regression
can be seen but not attributed: "the reviewer missed the bug" and "the reviewer was never
shown the bug" produce the same red test and need opposite fixes. See
[README.md](./README.md#planner-metrics--upstream-of-all-four-buckets-and-built-first) for
the metric table and the two defects the numbers found.

**Phase 0 remains frozen.** Every defect found so far has been an implementation
or runtime problem — transaction boundaries, unstable execution identity, test
harnesses that reported success without running. None was evidence that
`ReviewRun`, findings, verification, fingerprints, or the provider-neutral
contracts need redesigning.

---

## P1-I: the checkpoint that could not have failed

The modules were built and tested. Nothing called them.

A probe against the live orchestrator, on a run driven through the real
lifecycle, produced:

```
candidate_findings              2
verifications      (legacy)     2
verification_attempts           0    ← the P1-I table, never written
review_findings                 2    ← verification_attempt_id NULL
publication_intents             3    ← one comment per finding, no policy
```

`VerificationStore`, `promoteVerified` and `planPublication` had **zero
production callers**. Every guarantee was asserted about a library the worker
did not use.

And `findLifecycleViolations` already contained the two queries that catch
exactly this. It was only ever called from a fixture seeding a run parked in
`publishing` with no candidates and no findings, so both queries scanned zero
rows and returned clean. Pointed at a run the orchestrator drove, it reported
four violations immediately.

The lesson is not "wire it up". **A boundary enforced by which function a worker
happens to call is not a boundary.** Each joint of the funnel is now behind
something the database will not let a caller skip:

```
an attempt   → requires a scheduled invocation    composite FK on
                                                  (invocation, candidate, ordinal)
a finding    → requires a VERIFIED attempt        FK to a generated column that
                                                  is NULL for every other outcome
a comment    → requires a `publish` decision      FK to a generated column that
                                                  is NULL for a withheld one
a merge block → cannot see publication state      no column, no FK, no import,
                                                  enforced by dependency-cruiser
```

The legacy `verifications` table is dropped: `UNIQUE (candidate_finding_id)`
with `ON CONFLICT DO NOTHING` silently discarded a second verification, and
while it existed "the run has been verified" was satisfiable by a table the
guarantees say nothing about.

### Allocation is serialized, not raced

The attempt ordinal comes from a durable `verification_invocations` row,
allocated under a `FOR UPDATE` lock on the candidate taken **before** anything
is read. The difference from the rejected design is not the arithmetic — it is
that the read and the write happen under a lock held to commit, so contention
**blocks** and never decides. Redelivery versus retry is answered by reading the
request key under that lock, never by catching a unique violation.

### Two mutations that survived, and what they exposed

Disabling the `every_candidate_examined` prerequisite, and letting an
`unavailable` attempt satisfy it, both passed the entire suite. The orchestrator
verifies everything before requesting that transition, so the guard is only
reachable from an externally corrupted database — which is what it is for, and
why it needed a test that reaches it deliberately. 20/20 mutations now killed,
every one with `executed > 0` and `skipped = 0`.

---

## E.3 experiment: Outcome A

The probe ran against a live App on a real pull request. Recovery works: the
pending review was discoverable, the body marker survived byte-identically, the
provider review id was recovered without having seen the create response, inline
comments were retrievable, the recovered review was submitted, and exactly one
logical publication resulted. Full evidence in
[e3-experiment.md](./e3-experiment.md).

The second experiment is the one that shapes the protocol. GitHub refuses a
second **pending** review (422, "User can only have one pending review per pull
request") but places no constraint once a review has been **submitted**. So a
blind retry is harmless in the first window and produces a visible duplicate in
the second — which is why reconcile-before-create is correctness rather than
tidiness, and why the body marker has to exist at all.

The publisher was then built on that evidence: the ledger completed by what
GitHub actually returns, reconcile-before-create, `unknown` as a first-class
state, an eleven-case crash matrix against real Postgres, and the
`completed ⇒ all intents provider-confirmed` entailment that E.2 had to defer.
Ten mutations planted, ten killed. See
[e3-publication.md](./e3-publication.md).

---

## What being blocked established, and why that was the right state

The entire publication design rests on one claim about GitHub's behaviour:

> If creation succeeds remotely but the response is lost locally, can Acalys
> rediscover the exact pending review from provider state alone?

GitHub documents that pending reviews can be created (by omitting `event`),
listed, fetched, and submitted later. It does **not** document the lost-response
case, and inferring it from the endpoint list is exactly the assumption that
produces duplicate comments in production.

So this is a genuine external dependency, not a stall:

```
E.3 BLOCKED — external prerequisite unavailable
```

is better engineering than

```
E.3 COMPLETE — a mock behaved the way we hoped.
```

**What is needed:** a GitHub App installed on a scratch repository with an open
pull request, and its private key. The probe writes to a real PR.

**What runs first:**
[`packages/providers/github/scripts/pending-review-probe.ts`](../../../packages/providers/github/scripts/pending-review-probe.ts).
It mints the effect identity, creates a pending review carrying the marker,
discards the response, then tries to recover and submit from provider state
alone — recording every raw request and response so the design is made from
evidence rather than hope. It refuses to run without real credentials.

### What each outcome means

| Outcome                                        | Consequence                                                         |
| ---------------------------------------------- | ------------------------------------------------------------------- |
| **A** — pending review reliably rediscoverable | marker reconciliation works; the ledger design holds unchanged      |
| **B** — visible but awkward to recover         | adapt the effect metadata or lookup strategy                        |
| **C** — cannot be reliably rediscovered        | narrow or redesign the provider publication protocol                |
| **D** — uncertainty is irreducible             | expose an explicit operational reconciliation / manual-repair state |

All four stay inside the additive publication layer. That is the payoff from
keeping `PublicationEffect` an internal persistence concept rather than
elevating it to a canonical contract before it had been validated.

---

## What E.2 established that E.3 depends on

**`publishing` is a durable obligation, not an execution status.** Entering it
means the decision to make the review externally visible is irrevocable and the
system now owes convergence of external state. A worker may die; the obligation
survives it. That is why `publishing → superseded` does not exist.

**Publication intents are written in the transaction that enters `publishing`**,
so the ledger outlives the process that created it. Asserted database-wide: no
run is in `publishing` with an empty ledger.

**The ledger records intent, not success.** `unknown` is the state that makes it
necessary — a timeout means _we do not know whether the provider committed the
effect_, never _it did not_. Collapsing `unknown` into `failed` is precisely how
duplicate comments happen.

**Both a stable `logical_key` and a `content_digest`**, because they answer
different questions: _is this effect already represented?_ versus _is it the
effect we intended?_ A key reused with a changed digest is an invariant
violation, not a retry.

---

## Open items carried into E.3

1. **`state = completed` ⟹ every publication intent is provider-confirmed.**
   Cannot be asserted until E.3 defines what confirmed means. The entailment
   suite has a place for it.

2. **The analyzer's real cache key is not `inputDigest`.** The stub's digest is
   repository + head commit, which fully determines _its_ output and nothing
   else's. A real analyzer's input is strictly larger:

   ```
   code / change identity      repository · base and merge base · head ·
                               normalized ChangeManifest
   analyzer-input identity     the above · resolved instructions and config
                               snapshot · context snapshot digest · analyzer
                               id and version
   ```

   Reducing that to the head commit would make "same head SHA" silently mean
   "same analysis" while the actual prompt differed. The second layer is what
   `AnalysisContextSnapshot.digest` is for — see
   [context-provenance.md](./context-provenance.md). Documented at the function
   itself so a future caching change cannot make the mistake quietly.

3. **The publisher itself is unwritten, deliberately.** No provider-specific
   publication code lands before the probe passes.
