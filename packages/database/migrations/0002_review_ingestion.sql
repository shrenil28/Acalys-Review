-- Review ingestion: the tables a delivery becomes.
--
-- Four levels, and keeping them apart is what makes the metrics that matter
-- computable later:
--
--     WebhookDelivery   "GitHub told us X"              0001
--     ReviewRequest     "a review is wanted for X"      here
--     ReviewRun         "one logical execution"         here
--     job attempt       "infrastructure tried"          0001 (webhook_jobs.attempts)
--
-- The distinction that decides the schema: a **worker crash creates another job
-- attempt, not another ReviewRun.** `review_runs.attempt` counts *domain*
-- attempts — a rerun someone asked for, or a retry after a provider 503 — while
-- `webhook_jobs.attempts` counts how many times infrastructure tried to execute
-- the same logical work.
--
-- Collapsing them would inflate "how many reviews did we run" with every
-- Kubernetes eviction, and make review latency, retry rate, and cost per review
-- meaningless. So every write below is idempotent: a retried job converges onto
-- the rows the crashed one created rather than making new ones.

CREATE TABLE organizations (
    id          UUID PRIMARY KEY,
    slug        TEXT        NOT NULL UNIQUE,
    name        TEXT        NOT NULL,
    lifecycle   TEXT        NOT NULL DEFAULT 'active',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE repositories (
    id                    UUID PRIMARY KEY,
    organization_id       UUID        NOT NULL REFERENCES organizations(id),
    provider              TEXT        NOT NULL,
    -- The provider's immutable numeric id, never `owner/name`: repositories are
    -- renamed and transferred, and a path-keyed row silently detaches from its
    -- subject (§8).
    provider_external_id  TEXT        NOT NULL,
    owner                 TEXT        NOT NULL,
    name                  TEXT        NOT NULL,
    default_branch        TEXT        NOT NULL,
    visibility            TEXT        NOT NULL,
    installation_id       TEXT,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (provider, provider_external_id)
);

CREATE INDEX repositories_org_idx ON repositories (organization_id);

CREATE TABLE pull_requests (
    id                    UUID PRIMARY KEY,
    -- Denormalized (§9). Every tenant-scoped query filters on this, and a
    -- policy that has to join upward to find the tenant is a policy a view can
    -- defeat.
    organization_id       UUID        NOT NULL REFERENCES organizations(id),
    repository_id         UUID        NOT NULL REFERENCES repositories(id),
    provider              TEXT        NOT NULL,
    provider_external_id  TEXT        NOT NULL,
    number                INTEGER     NOT NULL,
    title                 TEXT        NOT NULL,
    description           TEXT,
    author                JSONB       NOT NULL,
    state                 TEXT        NOT NULL CHECK (state IN ('open','closed','merged')),
    draft                 BOOLEAN     NOT NULL,
    labels                JSONB       NOT NULL DEFAULT '[]'::jsonb,
    created_at            TIMESTAMPTZ NOT NULL,
    updated_at            TIMESTAMPTZ NOT NULL,

    UNIQUE (repository_id, provider_external_id)
);

CREATE INDEX pull_requests_repo_state_idx
    ON pull_requests (repository_id, state, updated_at DESC);

-- Immutable and append-only. No updated_at: a revision is a fact about a point
-- in history, and correcting one means recording a new one.
CREATE TABLE pull_request_revisions (
    id               UUID PRIMARY KEY,
    organization_id  UUID        NOT NULL REFERENCES organizations(id),
    repository_id    UUID        NOT NULL REFERENCES repositories(id),
    pull_request_id  UUID        NOT NULL REFERENCES pull_requests(id),

    -- Arrival order, not necessarily the order the pushes happened. GitHub
    -- states webhook deliveries can arrive out of order, so this is a local
    -- sequence number and NOT an authority on repository history — head_sha is.
    -- See `supersededBy` handling in the store.
    sequence         INTEGER     NOT NULL CHECK (sequence >= 1),

    head_sha         TEXT        NOT NULL,
    head_ref         TEXT        NOT NULL,
    base_sha         TEXT        NOT NULL,
    base_ref         TEXT        NOT NULL,
    merge_base_sha   TEXT,
    trigger          TEXT        NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL,

    -- "The third revision" must be unambiguous under concurrent delivery: two
    -- workers racing to insert sequence 3 means one fails loudly.
    UNIQUE (pull_request_id, sequence),
    -- The real identity. A redelivery of the same push, or two deliveries that
    -- name the same head, converge onto one row instead of creating a second
    -- revision for the same code.
    UNIQUE (pull_request_id, head_sha)
);

-- Intent. Carries the idempotency key, which is what makes a redelivery or a
-- crashed-and-retried job find the existing request rather than opening a
-- second one (§47).
CREATE TABLE review_requests (
    id                  UUID PRIMARY KEY,
    organization_id     UUID        NOT NULL REFERENCES organizations(id),
    repository_id       UUID        NOT NULL REFERENCES repositories(id),
    pull_request_id     UUID        REFERENCES pull_requests(id),
    revision_id         UUID        REFERENCES pull_request_revisions(id),

    target              JSONB       NOT NULL,
    trigger             TEXT        NOT NULL,
    requested_by        JSONB       NOT NULL,
    execution_mode      TEXT        NOT NULL,
    execution_strategy  TEXT        NOT NULL,

    idempotency_scope   TEXT        NOT NULL,
    idempotency_key     TEXT        NOT NULL,
    requested_at        TIMESTAMPTZ NOT NULL,

    -- Scoped by tenant, not global. A shared key space would let one
    -- organization's request suppress another's — a cross-tenant leak through
    -- a deduplication table, and the nastiest kind because it looks like an
    -- optimization.
    UNIQUE (idempotency_scope, idempotency_key)
);

CREATE INDEX review_requests_revision_idx ON review_requests (revision_id);

-- One logical execution. `attempt` is a DOMAIN attempt: a rerun, or a retry
-- after a retryable failure. A worker crash does not increment it.
CREATE TABLE review_runs (
    id                  UUID PRIMARY KEY,
    organization_id     UUID        NOT NULL REFERENCES organizations(id),
    repository_id       UUID        NOT NULL REFERENCES repositories(id),
    request_id          UUID        NOT NULL REFERENCES review_requests(id),
    revision_id         UUID        REFERENCES pull_request_revisions(id),

    attempt             INTEGER     NOT NULL CHECK (attempt >= 1),
    state               TEXT        NOT NULL CHECK (state IN (
                          'queued','preparing','analyzing','reviewing','verifying',
                          'reconciling','publishing','completed','failed',
                          'cancelled','superseded')),
    execution_mode      TEXT        NOT NULL,
    execution_strategy  TEXT        NOT NULL,

    failure_code        TEXT,
    failure_retryability TEXT,

    created_at          TIMESTAMPTZ NOT NULL,
    started_at          TIMESTAMPTZ,
    completed_at        TIMESTAMPTZ,

    -- The convergence point. A crashed job that already created run
    -- (request, 1) finds it again instead of creating (request, 2).
    UNIQUE (request_id, attempt)
);

-- The scheduler's working set. Partial, because most rows are terminal forever
-- and indexing them would grow without bound for a query that never reads them.
CREATE INDEX review_runs_active_idx
    ON review_runs (repository_id, created_at)
    WHERE state NOT IN ('completed','failed','cancelled','superseded');

CREATE INDEX review_runs_revision_idx ON review_runs (revision_id);

-- Append-only. A child table rather than a JSONB array on the run: the history
-- is unbounded, and appending to a JSONB column rewrites the whole value on
-- every transition.
CREATE TABLE review_run_transitions (
    run_id      UUID        NOT NULL REFERENCES review_runs(id) ON DELETE CASCADE,
    seq         INTEGER     NOT NULL,
    from_state  TEXT        NOT NULL,
    to_state    TEXT        NOT NULL,
    at          TIMESTAMPTZ NOT NULL,

    PRIMARY KEY (run_id, seq)
);

-- Lease support for webhook_jobs, so a worker that dies after claiming does not
-- hold a job forever. Without this, `locked_at IS NULL` never becomes true
-- again and the delivery is stuck in `processing` with nothing to recover it —
-- and GitHub will not redeliver it.
ALTER TABLE webhook_jobs ADD COLUMN lease_expires_at TIMESTAMPTZ;
ALTER TABLE webhook_jobs ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 5;
ALTER TABLE webhook_jobs ADD COLUMN dead_lettered_at TIMESTAMPTZ;

DROP INDEX webhook_jobs_claimable_idx;

-- Claimable = never locked, or leased to a worker that has since died.
CREATE INDEX webhook_jobs_claimable_idx
    ON webhook_jobs (available_at)
    WHERE dead_lettered_at IS NULL;
