-- Phase 4 / Checkpoint 4.6 — harden durable review-analysis cache payload bounds.
--
-- A cache is an optimization, never review truth. Oversized/corrupted rows must
-- degrade to a miss and must not become a way to store or hydrate unbounded JSON.

DELETE FROM review_analysis_cache_entries
 WHERE payload_bytes < 1
    OR payload_bytes > 1048576;

ALTER TABLE review_analysis_cache_entries
  DROP CONSTRAINT IF EXISTS review_analysis_cache_payload_size;

ALTER TABLE review_analysis_cache_entries
  ADD CONSTRAINT review_analysis_cache_payload_size
  CHECK (payload_bytes BETWEEN 1 AND 1048576);
