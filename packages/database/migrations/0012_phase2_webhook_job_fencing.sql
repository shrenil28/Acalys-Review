-- Phase 2 production-reachability hardening.
--
-- Webhook job leases were recoverable but not fenced. A worker could finish
-- after its lease was reclaimed and delete/release the newer owner's job.
-- Claim generation turns every settlement into a compare-and-set operation.
ALTER TABLE webhook_jobs
    ADD COLUMN claim_generation BIGINT NOT NULL DEFAULT 0
        CHECK (claim_generation >= 0);
