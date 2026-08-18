# P1-E.3 — the publication protocol

What was built after the experiment classified Outcome A. The evidence it is
built on is in [e3-experiment.md](./e3-experiment.md); this document is the
implementation and the proofs.

The guarantee, stated the only way the provider supports:

> Acalys executes publication at least once internally when needed. Stable
> publication identity minted before the first request, plus reconciliation
> against provider state, make the externally visible result converge
> idempotently.

Not exactly-once. GitHub exposes no primitive that would make that claim true.

---

## Design changes the live provider forced

| Sketch (E.2)                            | Reality (E.3)                                                 | Consequence                                                                             |
| --------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| one `provider_reference`                | GitHub returns `id`, `node_id`, **and** `commit_id`           | three columns; the commit id is what content verification is relative to                |
| a publication belongs to a pull request | every review carries `commit_id`                              | `revision_id` on the ledger, or two runs against different pushes are indistinguishable |
| `published` = a 2xx was received        | a 2xx can be lost after the provider commits                  | `published` requires `confirmed_at` **and** a reference, enforced by a CHECK            |
| 5xx is retryable                        | a 502 on a write may mean the write happened                  | 5xx on a **mutating** request is `ambiguous`; on a read it stays retryable              |
| 422 is a permanent input error          | 422 can mean "you already created one"                        | that specific 422 is `ambiguous` — an instruction to re-read, not to give up            |
| `state` identifies a pending review     | `submitted_at: null` is the direct fact                       | pendingness is read from the timestamp                                                  |
| a blind retry is the main risk          | GitHub refuses one _while pending_, permits it _after submit_ | reconcile-before-create is correctness in the second window                             |

Two defects were also found in code E.2 had already shipped:

- **The digest check was a comment, not a check.** `runStage` performed
  `ON CONFLICT … DO UPDATE` and discarded the result, while the comment above it
  claimed the caller compared digests. Nothing compared anything. Same logical
  key with changed content now raises `PublicationContentConflict`.
- **A row left in `attempting` by a dead worker was unresumable**, and a failure
  during the reconciliation lookup had nowhere to be recorded — the transition
  table had no `planned → failed` or `attempting → attempting`. Both were found
  by the crash matrix, not by reading the table.

---

## Persistence

Migration `0004_publication_ledger.sql`, additive to the table `0003` created.

```
publication_intents
  id, organization_id, review_run_id          tenant + run identity
  provider, pull_request_id, revision_id      what is being published, where
  kind                                        review | inline_comment | summary | check
  logical_key                                 stable identity, minted before any request
  content_digest                              what that identity was supposed to say
  state                                       planned | attempting | unknown | published | failed
  provider_reference, provider_node_id,       three distinct provider facts
    provider_commit_id
  attempts, last_error_code, last_error_class  retryable | permanent | ambiguous
  confirmed_at                                when the effect was OBSERVED
  reconciled_at                               when provider state was last read
  next_attempt_at                             backoff
  claimed_by, claimed_until                   lease
```

**Constraints, which are where the invariants actually live:**

```sql
UNIQUE (logical_key)                    -- globally, not per-run: the key embeds
                                        -- every scope, so a cross-run collision
                                        -- means the generator dropped one
CHECK state <> 'published'
   OR (provider_reference IS NOT NULL AND confirmed_at IS NOT NULL)
CHECK state <> 'unknown' OR attempts > 0
```

The first CHECK is the one that makes `completed ⇒ provider-confirmed` mean
something. Without it, `published` is satisfiable by belief.

**The logical key is written out rather than abbreviated:**

```
acalys:github:{org}:{repo}:{pullRequest}:{revision}:{run}:{kind}:{discriminator}
```

`review:${runId}` would also have been unique — a run id is a UUID — which is
exactly what made it dangerous. Correct by accident is indistinguishable from
correct, right up until a key drops a scope.

Deliberately **not** derived from the head SHA, a finding's line, the provider
review id, or the delivery id. The first two are content, the third does not
exist until after the effect it would identify, and the fourth is transport.

---

## The lifecycle

```
     planned  ──▶ attempting ──┬──▶ published   (observed in provider state)
        ▲ │         ▲   │      ├──▶ unknown     (we do not know)
        │ │         │   │      ├──▶ failed      (permanently rejected)
        └─┘         └───┘      └──▶ planned     (retryable, backing off)
      backoff    replacement
                   worker
                            unknown ──▶ published | failed | attempting
```

`unknown → planned` does not exist. It would be a blind retry with a backoff
attached, which is the move that publishes duplicates. Every exit from `unknown`
goes through a provider lookup, and `beginAttempt` refuses to leave `unknown` or
`attempting` unless `reconciled_at >= updated_at` — reported as
`reconciliation_required` rather than `refused`, so a caller cannot read it as
"lost a race, try again".

---

## Crash matrix

Real Postgres, and a provider double whose rules are transcribed from the live
transcripts — including the one that matters: a create is refused while a review
is pending and **permitted** once one is submitted. A double that refused in
both cases would make case 4 pass for a reason GitHub does not provide.

| #   | Scenario                                    | Result                                                                       |
| --- | ------------------------------------------- | ---------------------------------------------------------------------------- |
| 1   | crash before the provider request           | same intent, safe retry, zero effects, then one                              |
| 2   | crash after `attempting`, before the write  | replacement worker converges; one effect                                     |
| 3   | provider succeeded, DB update lost          | recovery finds it; **one** create call total                                 |
| 4   | **response deliberately lost after commit** | `unknown` (not `failed`); fresh process rediscovers and confirms; one effect |
| 5   | permanent rejection                         | `failed`, no backoff, terminal — a replay contacts nobody                    |
| 6   | throttle / retryable                        | `planned` + backoff; not claimable until due; identity unchanged             |
| 7   | multi-finding review                        | one publication unit, recovered as one                                       |
| 8   | two publisher workers race                  | exactly one `confirmed`; ≤1 create                                           |
| 8b  | two claimers                                | the lease gives the row to one                                               |
| 9   | superseded before the publishing commit     | `publishing → superseded` is illegal; zero effects                           |
| 10  | worker dies after entering `publishing`     | obligation survives; replacement resumes                                     |
| 11  | completed run replayed                      | no provider call, no state movement, `confirmed_at` unchanged                |

Plus: a marker match with different content raises
`PublicationInvariantViolation` and leaves provider state untouched and the
ledger unmoved — neither available resolution is safe, so neither is taken.

---

## Lifecycle entailments

Asserted database-wide by `findLifecycleViolations`, not per-run:

```
publishing  ⇒  required publication intents exist
completed   ⇒  every intent is provider-confirmed      (deferred in E.2, now defined)
published   ⇒  provider_reference AND confirmed_at     (also a CHECK constraint)
superseded  ⇒  cannot publish                          (publishing → superseded is illegal)
publishing  ⇒  survives worker death                   (case 10)
```

The `published`-without-evidence query is unreachable through SQL because of the
CHECK. It is asserted anyway: the query proves the constraint is present, and
would catch a migration that dropped it.

---

## Secret safety

Two paths, both tested with planted unmistakable markers.

**The probe transcripts** — credentials registered at the point they are created
(PEM on read, JWT on sign, installation token on receipt), scrubbed by value
from everything recorded, and a writer that refuses to emit output matching the
_shape_ of a credential even when nobody registered it. Headers have no field to
be recorded into.

**Errors, which is the quieter path.** GitHub echoes request material into
`message`; error objects are logged by default in most stacks; and
`last_error_code` is persisted to the ledger. So `GithubProviderError` carries a
low-cardinality code and never provider text, and a thrown transport error is
never propagated — a `fetch` error carries the Request, and the Request carries
the `Authorization` header. Forced 401, 403, 429, 500, 422, transport failure
and JSON parse failure; asserted the marker appears in no message, no
serialized error, no stack, and no stored code.

---

## Mutations

Ten planted, ten killed.

| Mutation                                               | Killed by |
| ------------------------------------------------------ | --------- |
| remove the unique identity constraint                  | 32 tests  |
| mint identity after the POST (unstable across replans) | 4         |
| collapse `unknown` into `failed`                       | 3         |
| retry an ambiguous row without reconciliation          | 1         |
| skip provider-state reconciliation                     | 4         |
| reconcile by marker, ignore content mismatch           | 1         |
| mark a run completed before intents are confirmed      | 1         |
| allow a superseded run to enter `publishing`           | 4         |
| allow a `publishing` run to be superseded              | 3         |
| split the publishing transition from intent creation   | 37        |

---

## Phase 0

```
Phase 0 remains frozen; E.3 was additive.
```

Nothing observed required a Phase 0 contract to change. The ledger is a Phase 1
persistence concept, and keeping `PublicationEffect` internal is what let the
protocol absorb seven corrections from the live provider without touching a
frozen contract.
