# Phase 1 status

```
P1-A     GitHub normalization                      ✓
P1-B     GitHub App authentication                 ✓
P1-C     secure durable webhook ingestion          ✓
P1-D     claims · leases · retries · concurrency   ✓
P1-E.1   delivery → queued ReviewRun               ✓
P1-E.2   deterministic lifecycle + crash recovery  ✓
P1-E.3   real GitHub publication reconciliation    ✓
P1-F     code intelligence + context planner       ✓
P1-F.2   planner eval — metrics + committed baseline  ✓
```

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
