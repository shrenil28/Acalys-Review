-- Webhook inbox and job outbox.
--
-- These two tables are where "durably own exactly once" stops being a design
-- intention and becomes a database guarantee. Everything the gateway does is
-- arranged around the constraint on line 48: the application does not decide
-- whether a delivery is a duplicate, the unique index does.
--
-- That distinction matters under concurrency. An application-level
-- "SELECT then INSERT if absent" is a race with a window between the two
-- statements, and two gateway replicas handling the same redelivery will both
-- see nothing and both insert. Only the constraint is atomic.

CREATE TABLE webhook_deliveries (
    id                UUID PRIMARY KEY,

    provider          TEXT        NOT NULL,

    -- The uniqueness scope. Delivery ids are unique per *webhook*, not
    -- globally, and the platform will run more than one endpoint — a GitHub
    -- App, a per-repository hook during migration, a staging endpoint replaying
    -- production traffic. Keying on delivery_id alone means a staging replay
    -- silently suppresses the production delivery it was copied from.
    source_endpoint_id TEXT       NOT NULL,

    -- X-GitHub-Delivery. Stable across GitHub-initiated redeliveries and across
    -- a manual "Redeliver" from the UI, which is exactly what makes it usable
    -- as an idempotency key.
    delivery_id       TEXT        NOT NULL,

    event             TEXT        NOT NULL,
    action            TEXT,

    -- SHA-256 of the authenticated raw body, lowercase hex.
    --
    -- Present so a duplicate can be distinguished from an anomaly. Same
    -- delivery_id with a different digest is not a redelivery: GitHub does not
    -- reuse ids, so it means something between GitHub and here rewrote the
    -- body. `ON CONFLICT DO NOTHING` would discard exactly that evidence.
    body_digest       CHAR(64)    NOT NULL,

    -- The bytes themselves, so a worker crash after acknowledgement does not
    -- leave the platform knowing a delivery existed while unable to process it.
    -- A digest proves identity; bytes enable replay.
    payload           BYTEA       NOT NULL,

    received_at       TIMESTAMPTZ NOT NULL,
    -- Non-null by construction: a row only exists after signature verification.
    authenticated_at  TIMESTAMPTZ NOT NULL,

    state             TEXT        NOT NULL
                      CHECK (state IN ('received','processing','processed','ignored','failed')),
    outcome_reason    TEXT,
    attempts          INTEGER     NOT NULL DEFAULT 0 CHECK (attempts >= 0),

    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- THE constraint. Exactly-once ingestion is this line.
    CONSTRAINT webhook_deliveries_endpoint_delivery_key
        UNIQUE (source_endpoint_id, delivery_id)
);

-- The recovery query. GitHub does not automatically redeliver a failed
-- delivery, so anything stuck in `received` or `processing` past a threshold is
-- work nobody will resend — it must be found here or it is lost. Partial, so
-- the index holds only the working set rather than every delivery ever seen.
CREATE INDEX webhook_deliveries_unsettled_idx
    ON webhook_deliveries (received_at)
    WHERE state IN ('received', 'processing');

-- Operator lookup: "what happened to delivery abc-123?"
CREATE INDEX webhook_deliveries_delivery_id_idx
    ON webhook_deliveries (delivery_id);


-- The outbox half.
--
-- Written in the same transaction as its delivery, which is the entire point:
-- there is no committed state in which a delivery is owned and no work is
-- scheduled. The alternative — acknowledge, then enqueue — loses the event
-- permanently if the process dies between the two, because GitHub will not
-- resend it.
CREATE TABLE webhook_jobs (
    id                UUID PRIMARY KEY,

    -- ON DELETE CASCADE, because a job without its delivery cannot be executed:
    -- the payload it needs lives on the delivery row.
    delivery_row_id   UUID        NOT NULL
                      REFERENCES webhook_deliveries(id) ON DELETE CASCADE,

    kind              TEXT        NOT NULL,
    payload           JSONB       NOT NULL,

    available_at      TIMESTAMPTZ NOT NULL,
    attempts          INTEGER     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    locked_at         TIMESTAMPTZ,
    last_error_code   TEXT,

    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The worker's claim query: oldest available first, unlocked only. Partial so
-- completed work leaves the index entirely and it stays proportional to the
-- backlog rather than to history.
CREATE INDEX webhook_jobs_claimable_idx
    ON webhook_jobs (available_at)
    WHERE locked_at IS NULL;
