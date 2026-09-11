-- Phase 4 / Checkpoint 4.6 — durable review-analysis cache.
--
-- The cache stores only successful deterministic cluster-analysis results. It is
-- an optimization, never source-of-truth review state: deleting a row forces the
-- next matching review to recompute that cluster before it can be cached again.

CREATE TABLE IF NOT EXISTS review_analysis_cache_entries (
    id                UUID PRIMARY KEY,
    organization_id   UUID NOT NULL,
    repository_id     UUID NOT NULL,
    fingerprint       CHAR(64) NOT NULL,
    payload           JSONB NOT NULL,
    payload_bytes     BIGINT NOT NULL CHECK (payload_bytes >= 0),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    last_used_at      TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    expires_at        TIMESTAMPTZ NOT NULL,
    CONSTRAINT review_analysis_cache_fingerprint_shape
      CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
    CONSTRAINT review_analysis_cache_tenant_fk
      FOREIGN KEY (organization_id, repository_id)
      REFERENCES repositories (organization_id, id)
      ON DELETE CASCADE,
    CONSTRAINT review_analysis_cache_expiry_order
      CHECK (expires_at > created_at),
    UNIQUE (organization_id, repository_id, fingerprint)
);

CREATE INDEX IF NOT EXISTS review_analysis_cache_ready_idx
    ON review_analysis_cache_entries
       (organization_id, repository_id, expires_at DESC, last_used_at DESC);

CREATE INDEX IF NOT EXISTS review_analysis_cache_org_updated_idx
    ON review_analysis_cache_entries
       (organization_id, updated_at DESC, id);
