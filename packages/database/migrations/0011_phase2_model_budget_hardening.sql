ALTER TABLE model_interactions
    ADD COLUMN cache_creation_input_tokens BIGINT NOT NULL DEFAULT 0
        CHECK (cache_creation_input_tokens >= 0);

-- Phase 2 hardening — reserve model spend atomically before provider dispatch.
--
-- The interaction ledger alone cannot enforce a ceiling: two workers can both
-- read the same remaining budget and dispatch before either records usage.
-- Reservations close that race. They use database time. Reservations abandoned
-- before dispatch expire; once dispatch intent is durable, an unresolved row
-- remains conservative until interaction accounting or operator reconciliation.
CREATE TABLE model_budget_reservations (
    id                       UUID PRIMARY KEY,
    organization_id          UUID        NOT NULL REFERENCES organizations(id),
    review_run_id            UUID        NOT NULL REFERENCES review_runs(id) ON DELETE CASCADE,
    reserved_cost_microusd   BIGINT      NOT NULL CHECK (reserved_cost_microusd >= 0),
    reserved_at              TIMESTAMPTZ NOT NULL,
    expires_at               TIMESTAMPTZ NOT NULL,
    dispatch_intended_at     TIMESTAMPTZ,
    released_at              TIMESTAMPTZ,
    CONSTRAINT model_budget_reservation_time_order
        CHECK (expires_at > reserved_at),
    CONSTRAINT model_budget_reservation_dispatch_order
        CHECK (dispatch_intended_at IS NULL OR dispatch_intended_at >= reserved_at),
    CONSTRAINT model_budget_reservation_release_order
        CHECK (released_at IS NULL OR released_at >= reserved_at)
);

CREATE INDEX model_budget_reservations_run_active_idx
    ON model_budget_reservations (review_run_id, expires_at)
    WHERE released_at IS NULL;
CREATE INDEX model_budget_reservations_org_active_idx
    ON model_budget_reservations (organization_id, expires_at)
    WHERE released_at IS NULL;
