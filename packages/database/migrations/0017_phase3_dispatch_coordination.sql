-- Phase 3 checkpoint 10: replica-safe API dispatch coordination.
--
-- The original ready index intentionally covered only never-leased rows. Once a
-- worker died, an expired non-NULL lease was still recoverable semantically but
-- no longer belonged to that index, making crash recovery progressively more
-- expensive as the queue grew. Keep the hot unleased index and add the matching
-- recovery index for expired leases.
CREATE INDEX IF NOT EXISTS review_dispatch_jobs_expired_lease_idx
  ON review_dispatch_jobs (lease_expires_at, available_at, review_run_id)
  WHERE lease_expires_at IS NOT NULL AND dead_lettered_at IS NULL;
