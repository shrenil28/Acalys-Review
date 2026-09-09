-- Phase 3 checkpoint 1: durable API-originated review dispatch.
CREATE TABLE IF NOT EXISTS review_dispatch_jobs (
    review_run_id UUID PRIMARY KEY REFERENCES review_runs(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    revision_id UUID NOT NULL REFERENCES pull_request_revisions(id) ON DELETE CASCADE,
    pull_request_id UUID NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
    available_at TIMESTAMPTZ NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    max_attempts INTEGER NOT NULL DEFAULT 8 CHECK (max_attempts > 0),
    dead_lettered_at TIMESTAMPTZ,
    claim_generation BIGINT NOT NULL DEFAULT 0 CHECK (claim_generation >= 0),
    lease_expires_at TIMESTAMPTZ,
    last_error_code TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS review_dispatch_jobs_ready_idx
  ON review_dispatch_jobs (available_at, review_run_id)
  WHERE lease_expires_at IS NULL AND dead_lettered_at IS NULL;

ALTER TABLE review_requests ADD COLUMN IF NOT EXISTS correlation_id TEXT;
CREATE INDEX IF NOT EXISTS review_requests_correlation_idx
  ON review_requests (organization_id, correlation_id)
  WHERE correlation_id IS NOT NULL;

ALTER TABLE review_runs ADD COLUMN IF NOT EXISTS cancel_reason TEXT;
ALTER TABLE review_findings ADD COLUMN IF NOT EXISTS dismissal_reason TEXT;
