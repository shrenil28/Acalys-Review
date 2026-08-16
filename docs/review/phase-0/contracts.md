# Contract reference

Every major contract with what §81 asks for: purpose, ownership, lifecycle, invariants,
and whether it is immutable or versioned. Serialized examples are the validated fixtures
in [`packages/contracts/tests/fixtures/`](../../../packages/contracts/tests/fixtures/).

**Legend.** _Versioned_ = carries `schemaVersion`. _Immutable_ = never updated after
creation; a correction is a new row.

---

## Domain contracts

| Contract                             | Created by                      | Consumed by                         | Immutable               | Versioned |
| ------------------------------------ | ------------------------------- | ----------------------------------- | ----------------------- | --------- |
| `Organization`, `User`, `Membership` | onboarding                      | authorization, every query          | no                      | no        |
| `ProviderConnection`                 | OAuth / App install             | provider adapters                   | no                      | no        |
| `Repository`                         | provider sync                   | everything repository-scoped        | no                      | no        |
| `PullRequest`                        | webhook normalization           | triage UI, review requests          | no                      | no        |
| `PullRequestRevision`                | webhook normalization           | review requests, incremental review | **yes**                 | no        |
| `ReviewTarget`                       | provider adapter / CLI          | review request                      | **yes**                 | **yes**   |
| `ReviewRequest`                      | webhook gateway, API, scheduler | scheduler → review runs             | **yes**                 | **yes**   |
| `ReviewRun`                          | scheduler                       | review worker, UI, events           | no (state advances)     | **yes**   |
| `ChangeManifest`                     | repository service              | reviewer, risk scoring              | **yes**                 | **yes**   |
| `Evidence`                           | tools, agents, CI               | verification, findings              | **yes**                 | **yes**   |
| `CandidateFinding`                   | reviewer agent, tools           | verification                        | **yes**                 | **yes**   |
| `ReviewFinding`                      | reconciliation                  | publication, UI, policy             | no (lifecycle advances) | **yes**   |
| `ReviewSummary`                      | reviewer agent                  | publication, UI                     | **yes**                 | **yes**   |
| `ReviewComment`                      | publication                     | provider adapters                   | no                      | no        |
| `ReviewConversation` / `Message`     | publication, chat               | UI, chat agent                      | messages **yes**        | no        |
| `SuggestedFix`                       | fix agent                       | publication, apply                  | **yes**                 | no        |
| `KnowledgeReference`                 | knowledge service               | reviewer, UI                        | **yes**                 | no        |
| `PreMergeCheckResult`                | pre-merge engine                | merge policy, UI                    | **yes**                 | no        |
| `ArtifactReference`                  | artifact store                  | evidence, findings                  | **yes**                 | no        |
| `ReviewConfig`                       | config resolution               | reviewer, tools, publication        | **yes**                 | **yes**   |
| `ReviewConfigSnapshot`               | config resolution               | review run                          | **yes** (frozen)        | **yes**   |

### Invariants worth stating

**`PullRequestRevision`** — immutable and sequenced. `unique (pull_request_id, sequence)`
is what makes "the third revision" unambiguous under concurrent webhook delivery: two
workers racing to insert sequence 3 means one fails loudly instead of both succeeding.

**`ReviewRun`** — `attempt` is 1-based within its request, and `unique (request_id,
attempt)` makes a retry a new row rather than a mutation. `history` is append-only.
`publishing` is the commit point and cannot be cancelled or superseded.

**`ReviewFinding`** — requires a `fingerprint` (a candidate's is optional; a finding's is
identity), at least one `candidateId`, and a `verification` whose decision is `verified`.
A published finding cannot be a rejected candidate — structural, because there is no row
to be in that state.

**`ReviewConfigSnapshot`** — deep-frozen at runtime, because `readonly` is erased at
compile time and a snapshot outlives the code that created it. §109 forbids mutation while
a review runs.

**`ArtifactReference`** — carries `classification` and `redaction`, and disclosure is
`canDisclose(artifact, destination)`. Pending redaction is never disclosable, and
`not_required` never overrides classification.

---

## Cross-aggregate invariants (§107)

Rules no single schema can express, and the service that owns each. Each is a **domain
service**, not a schema refinement, because it needs more than one aggregate to evaluate.

| Invariant                                         | Owner                        |
| ------------------------------------------------- | ---------------------------- |
| A transition is legal for the current state       | `ReviewRunTransitionService` |
| A finding's lifecycle transition is legal         | `FindingLifecycleService`    |
| A published finding is not a rejected candidate   | `FindingLifecycleService`    |
| A resolved finding was published first            | `FindingLifecycleService`    |
| A finding's location repository matches its run's | `FindingLifecycleService`    |
| A run's config snapshot belongs to its repository | `ReviewRunTransitionService` |
| A revision's sequence is contiguous               | repository service (Phase 1) |

Phase 0 declares these and implements the two that are pure functions over contracts. The
rest need storage, and are Phase 1.

---

## API contracts

Every DTO is **projected** from a domain type by an explicit `toDto()`, never maintained in
parallel.

| DTO                     | Projected from        | Renders                            |
| ----------------------- | --------------------- | ---------------------------------- |
| `RepositoryDto`         | `Repository`          | `pages/review/Repositories.tsx`    |
| `PullRequestSummaryDto` | `PullRequest`         | `pages/review/Triage.tsx`          |
| `ReviewRunDto`          | `ReviewRun`           | live review view                   |
| `ReviewSummaryDto`      | `ReviewSummary`       | summary / walkthrough              |
| `FindingDto`            | `ReviewFinding`       | `AiDeepScan.tsx`, `PrFindings.tsx` |
| `ConversationDto`       | `ReviewConversation`  | conversation list                  |
| `PreMergeCheckDto`      | `PreMergeCheckResult` | pre-merge panel                    |
| `KnowledgeItemDto`      | `KnowledgeReference`  | `pages/review/Learnings.tsx`       |
| `ReviewProgressEvent`   | `ReviewRunState`      | SSE stream                         |
| `ApiErrorDto`           | `SerializedError`     | every failure                      |

### What every projection removes

```
attempt · execution · configSnapshotId · history · fingerprint
organizationId · schemaVersion · confidence score · candidateIds
```

`ReviewRunDto` is the narrowest, and deliberately so. `history` is genuinely useful, but it
is a _worker's_ record of how the run progressed; a UI rendering it would break every time
the state machine gained a state. What the UI needs is the current state and whether it is
finished.

`FindingDto` exposes the confidence **level**, never the raw score. The score's scale
changes as verification improves; a user comparing `0.82` today with `0.82` next month
would be comparing nothing.

`organizationId` is absent because the caller's session determines the tenant. Echoing it
teaches a client that it is a parameter, and the next step is a client that sends one.

The exclusion is asserted by `tests/api/dto-leakage.test.ts`, which walks every schema in
the layer. It has been verified against a planted leak: adding `attempt` to `ReviewRunDto`
fails the walk.

---

## Event and command contracts

See [events.md](./events.md). Both envelopes are versioned; both are immutable by
definition — an event is a fact, a command is a recorded ask.

---

## Ports

Interfaces only. Declared here so Phase 1 implements against them; none is stubbed (§87).

| Port               | Purpose                               | Why injected                                                                   |
| ------------------ | ------------------------------------- | ------------------------------------------------------------------------------ |
| `Clock`            | current time                          | a `FixedClock` makes time-dependent contracts testable                         |
| `IdGenerator<TId>` | fresh branded ids                     | deterministic ids in tests                                                     |
| `ContentHasher`    | fingerprint, config, artifact digests | keeps `node:crypto` out of contracts, so the package loads in a browser bundle |

`ContentHasher` is synchronous on purpose. Web Crypto's `subtle.digest` is async, but
making the port async would propagate `await` through otherwise pure domain logic —
and server-side hashing, which is where hashing actually happens, is synchronous.
