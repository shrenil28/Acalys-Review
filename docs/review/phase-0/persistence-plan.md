# Persistence plan

**Status:** a plan, not an implementation. Phase 0 ships no ORM, no migration, and
no database dependency (§88–§91). This document exists so that Phase 1 can write the
schema without re-deciding anything the contracts already settled — and so that any
place where the contracts _would not_ map cleanly is visible now, while changing them
is still free.

Nothing in `packages/contracts` imports Prisma, a driver, or a decorator. §60 is the
reason: a domain type carrying persistence annotations makes the storage engine a
contract change.

---

## The rule that shapes every table

> Do not dump the whole domain into one JSONB column. (§66)

A column earns its place by being something the platform **queries, filters, joins, or
enforces**. Everything else — genuinely variant shapes, bulk content — is JSONB or an
artifact reference.

The test is concrete: §119 requires a future policy engine to answer _"block merges with
an unresolved critical security finding on this repository."_ That query touches
`severity`, `category`, `state`, and `repository_id`. All four are real columns. If they
lived inside a JSONB blob, the query would need a full scan and could not be indexed
without a functional index per field.

| Real column                        | Why                                                                  |
| ---------------------------------- | -------------------------------------------------------------------- |
| `severity`, `category`, `state`    | policy predicates (§119), UI filters, and closed enums               |
| `verification_decision`            | distinguishes a published finding from a rejected candidate (§107)   |
| `repository_id`, `organization_id` | every tenant-scoped query, every RLS predicate                       |
| `revision_id`                      | incremental review joins revision to revision (§29)                  |
| `fingerprint_value`                | the join key for finding lineage — indexed, never JSONB              |
| `created_at`, `updated_at`         | ordering and retention                                               |
| JSONB                              | `evidence.provenance`, `change_manifest` sub-arrays, `review_config` |
| Artifact reference                 | patches, logs, SARIF, snapshots — never a column (§45)               |

`review_config` is JSONB deliberately: a snapshot is read whole, never queried by field,
and its shape is the one thing that must be free to evolve without a migration per
setting.

---

## Tenancy

Every tenant-scoped table carries `organization_id` **denormalized**, even where it is
reachable by joining upward. §9 is explicit that a query must never have to traverse
back to the tenant, and the reasons compound:

- A missing `WHERE organization_id = $1` is the single most common cross-tenant bug. When
  the column is on every table, the predicate is uniform and reviewable.
- Row-level security needs the column _on the row_. A policy that joins to find the tenant
  is a policy that can be defeated by a view.
- A three-table join to answer "whose finding is this?" is a join that gets omitted under
  deadline.

The duplication is real, and it is the cheaper mistake.

```sql
-- Every tenant-scoped table, without exception.
organization_id  uuid  not null  references organizations(id)
```

---

## Tables

### Identity and tenancy

```
organizations         id, slug (unique), name, lifecycle, created_at, updated_at
users                 id, primary_email (unique), display_name, created_at, updated_at
memberships           id, organization_id, user_id, role, created_at
                      unique (organization_id, user_id)
provider_connections  id, organization_id, provider, external_account_id,
                      installation_ref, status, created_at, updated_at
                      unique (provider, external_account_id)
```

`memberships` is a table, not an array on `users`: a role is per-tenant, and a user in
three organizations has three independent roles.

**Credentials are not here.** A `provider_connection` holds a _reference_ to a secret in
a secret manager, never the token. §63 forbids credentials in contracts; a column would
put them in every backup, replica, and query log.

### Repositories and changes

```
repositories             id, organization_id, provider_connection_id, provider,
                         provider_external_id, owner, name, default_branch,
                         visibility, lifecycle, created_at, updated_at
                         unique (provider, provider_external_id)
                         index (organization_id, lifecycle)

pull_requests            id, organization_id, repository_id, provider,
                         provider_external_id, number, title, description,
                         author jsonb, state, draft, labels jsonb,
                         created_at, updated_at
                         unique (repository_id, provider_external_id)
                         index (repository_id, state, updated_at desc)

pull_request_revisions   id, organization_id, repository_id, pull_request_id,
                         sequence, head_sha, base_sha, merge_base_sha,
                         trigger, created_at
                         unique (pull_request_id, sequence)
                         unique (pull_request_id, head_sha)
```

Keyed by `provider_external_id`, never by name. The existing frontend fixtures key
repositories by `name`, which breaks the moment one is renamed or transferred — the
identity mistake §8 warns about, and one of the reasons `RepositoryId` exists.

`number` is stored but never a key. GitLab shares a numbering space between issues and
merge requests, so `#412` is ambiguous across resource types.

**Revisions are immutable and append-only.** No `updated_at`, no `UPDATE`. A revision is
a fact about a point in history; correcting one means recording a new one. `unique
(pull_request_id, sequence)` is what makes "the third revision" unambiguous under
concurrent webhook delivery — two workers racing to insert sequence 3 means one fails
loudly instead of both succeeding.

### Review lifecycle

```
review_requests   id, organization_id, repository_id, pull_request_id,
                  revision_id, target jsonb, trigger, requested_by jsonb,
                  execution_mode, execution_strategy, config_snapshot_id,
                  idempotency_key, idempotency_scope, requested_at
                  unique (idempotency_scope, idempotency_key)
                  index (repository_id, requested_at desc)

review_runs       id, organization_id, repository_id, request_id,
                  revision_id, attempt, state, config_snapshot_id,
                  failure_code, failure_retryability,
                  created_at, started_at, completed_at
                  unique (request_id, attempt)
                  index (repository_id, state) where state not in (terminal)
                  index (revision_id, created_at desc)

review_run_transitions  run_id, seq, from_state, to_state, at
                        primary key (run_id, seq)
```

`unique (idempotency_scope, idempotency_key)` is the whole of §47 in one constraint. A
redelivered webhook and an at-least-once queue both retry by default; without this, the
second delivery starts a second review, posts a second set of comments, and bills twice.
Scoping by tenant matters as much as the key: a global key space would let one tenant's
retry suppress another's request.

`unique (request_id, attempt)` makes a retry a _new row_, not a mutation. The failed
attempt survives, which is what makes "why did this review fail twice?" answerable.

The partial index on non-terminal `state` is the scheduler's working set. Most rows are
terminal forever; indexing them would grow the index without bound for a query that never
reads them.

`review_run_transitions` is a child table rather than a JSONB array on the run: the
history is append-only and unbounded, and appending to a JSONB column rewrites the whole
value on every transition.

### Findings, evidence, verification

```
candidate_findings  id, organization_id, repository_id, review_run_id,
                    title, claim, explanation, category, proposed_severity,
                    proposed_confidence_score, location jsonb,
                    produced_by jsonb, fingerprint_value, created_at
                    index (review_run_id)

findings            id, organization_id, repository_id, review_run_id,
                    revision_id, title, explanation,
                    category, severity, confidence_score, confidence_level,
                    verification_decision, verification jsonb,
                    fingerprint_algorithm, fingerprint_version, fingerprint_value,
                    path, start_line, end_line, location jsonb,
                    state, superseded_by, suggested_fix_id,
                    created_at, updated_at, deleted_at
                    index (repository_id, fingerprint_value)        -- lineage
                    index (repository_id, state, severity)          -- policy (§119)
                    index (review_run_id)

finding_candidates  finding_id, candidate_finding_id
                    primary key (finding_id, candidate_finding_id)

finding_transitions finding_id, seq, from_state, to_state, at, actor jsonb
                    primary key (finding_id, seq)

evidence            id, organization_id, review_run_id, type, strength,
                    provenance jsonb, summary, location jsonb,
                    artifact_id, created_at
                    index (review_run_id)

finding_evidence    finding_id, evidence_id
                    primary key (finding_id, evidence_id)
```

**Two tables, not one with a flag.** `candidate_findings` and `findings` are different
types with different fields — `claim` and `proposed_severity` versus `severity`,
`confidence`, and `verification` — and §107 requires that a published finding cannot
be a rejected candidate. One table with a `status` column would make that invariant a
trigger; two tables make it structural, because there is no row to be in the wrong state.

`index (repository_id, fingerprint_value)` is the index incremental review runs on. §29's
question — "is this finding the same one we reported last revision?" — is a lookup on
this index, executed once per candidate per run. Without it, incremental review degrades
to a scan of every finding in the repository.

`path`, `start_line`, `end_line` are duplicated out of `location` jsonb because the UI
groups findings by file and the policy engine filters by path glob. The jsonb keeps the
full location — `side`, `symbol`, `commit`, `columns` — which nothing queries.

`finding_evidence` is a join table: evidence is shared. One SARIF result can support three
findings, and one finding rests on several pieces of evidence.

### Output

```
comments               id, organization_id, repository_id, review_run_id,
                       finding_id, kind, provider, provider_external_id,
                       provider_thread_id, author jsonb, body,
                       location jsonb, created_at, updated_at
                       unique (provider, provider_external_id)
                          where provider_external_id is not null
                       index (review_run_id)

conversations          id, organization_id, repository_id, pull_request_id,
                       finding_id, root_comment_id, state,
                       created_at, updated_at
                       index (repository_id, state)

conversation_messages  id, organization_id, conversation_id, author jsonb,
                       body, provider_external_id, created_at
                       index (conversation_id, created_at)

suggested_fixes        id, organization_id, finding_id, description,
                       edits jsonb, validation_level, validated_at, created_at
```

The comment's `provider_external_id` is nullable and uniquely indexed _only when present_.
That is §35 in schema form: a comment exists in the platform before it exists on GitHub,
so the platform's `id` is the primary key and the provider's is a nullable attribute.
A `NOT NULL` provider id would make an unpublished comment unrepresentable, and a retry
would insert a duplicate rather than update the original.

`edits` is JSONB: a fix's edit list is read whole when the fix is applied and never
queried by field.

### Configuration and artifacts

```
config_snapshots  id, organization_id, repository_id, config jsonb,
                  source_hash_algorithm, source_hash_value, layers jsonb,
                  created_at
                  index (repository_id, created_at desc)
                  index (repository_id, source_hash_value)

artifacts         id, organization_id, kind, content_type, size_bytes,
                  checksum_algorithm, checksum_value, storage_reference,
                  classification, redaction_state, redaction_reason,
                  name, created_at, expires_at
                  index (organization_id, expires_at) where expires_at is not null
```

Snapshots are **insert-only**. §109 forbids mutating configuration while a review runs,
and an immutable row makes that structural rather than a rule someone remembers. The
`source_hash_value` index lets a second run of the same inputs reuse an existing snapshot
instead of writing a near-duplicate.

`artifacts` stores metadata; the bytes live in object storage behind `storage_reference`
(§45). `classification` and `redaction_state` are real columns because disclosure is a
policy decision made _before_ content is fetched — a query has to filter on them without
reading the object.

### Outbox (§67)

```
domain_event_outbox  id, organization_id, event_type, occurred_at,
                     correlation_id, causation_id, trace_id,
                     payload jsonb, schema_version,
                     published_at, attempts, last_error_code
                     index (published_at, occurred_at) where published_at is null
```

The failure this prevents:

```
BEGIN
  UPDATE review_runs SET state = 'completed' ...
COMMIT                          ← committed
  publish("review.run.completed")   ← process dies here
```

The state changed and nobody was told. Recovery is impossible, because there is no record
that an event was owed.

With an outbox, the event row is written **inside the same transaction** as the state
change. Either both land or neither does. A relay then reads unpublished rows and
publishes them — at-least-once, which is why consumers must be idempotent and why every
event carries a stable `id` to deduplicate on.

The partial index is the relay's query: `WHERE published_at IS NULL`, ordered by
`occurred_at`. Published rows leave the index entirely, so it stays small no matter how
many events have been emitted.

`correlation_id` and `causation_id` are columns, not JSONB, because reconstructing a
causal chain during an incident is a recursive query over exactly those two fields.

---

## Timestamps

Every timestamp column is `timestamptz`, and the application writes RFC 3339 UTC strings
(§6). Never `timestamp without time zone`: it stores a wall-clock reading with no
offset, so the same value means different instants depending on the session's `TimeZone`
setting — and a review's ordering silently changes when a replica is configured
differently.

`Date` never crosses a boundary in the contracts, and it should not enter one here
either: the driver's conversion is where the offset gets lost.

---

## Soft deletion and retention

Soft deletion applies **only** where a user can delete something that history still needs
to explain: `findings` (`deleted_at`), `repositories` and `organizations` (`lifecycle`).

It does **not** apply to `review_runs`, `evidence`, `pull_request_revisions`, or
`domain_event_outbox`. Those are the audit trail; a soft-deleted audit trail is not an
audit trail, and a hard-deleted one at least fails honestly.

Retention is by class, not one global policy — the classes have different costs and
different obligations:

| Data                              | Retention                             | Why                                             |
| --------------------------------- | ------------------------------------- | ----------------------------------------------- |
| findings, comments, conversations | tenant-configured, default indefinite | the product's value                             |
| review_runs, transitions          | 12 months                             | operational history; unbounded growth otherwise |
| evidence metadata                 | with its findings                     | a finding without evidence is unexplainable     |
| artifacts                         | 90 days, then storage-expired         | the bulk of the bytes                           |
| outbox, published                 | 7 days                                | replay window only                              |

`artifacts.expires_at` is a column so expiry is a query, not a scan.

---

## What Phase 1 must decide, and this document does not

Honest gaps, listed rather than glossed:

1. **Row-level security or application-level filtering.** RLS is stronger and costs a
   session variable per request. The `organization_id` column supports either; the
   decision needs a real connection-pooling design.
2. **Partitioning.** `findings` and `domain_event_outbox` are the growth tables. Neither
   needs partitioning at launch, and partitioning early would fix a key before the query
   patterns are known.
3. **The migration tool.** Prisma, Drizzle, or plain SQL. The contracts are indifferent —
   which is the point of §60.
4. **Whether `candidate_findings` is retained.** They are large and rarely read after the
   run completes. Keeping them makes §118's evaluation harness possible; dropping them
   halves the storage. This is a product decision, not a schema one.
