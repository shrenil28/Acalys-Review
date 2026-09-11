-- Phase 4 / Checkpoint 4.6 — make cache size metadata database-authoritative.
--
-- payload_bytes is used to bound cache hydration. It therefore cannot be trusted
-- as caller-supplied metadata: a corrupted/direct-SQL row could otherwise claim
-- to be tiny while carrying a very large JSONB value. Canonical JSONB text size
-- is the database authority and is constrained to the same 1 MiB entry budget.

DELETE FROM review_analysis_cache_entries
 WHERE octet_length(payload::text) < 1
    OR octet_length(payload::text) > 1048576;

UPDATE review_analysis_cache_entries
   SET payload_bytes = octet_length(payload::text)
 WHERE payload_bytes IS DISTINCT FROM octet_length(payload::text);

ALTER TABLE review_analysis_cache_entries
  DROP CONSTRAINT IF EXISTS review_analysis_cache_canonical_payload_size;

ALTER TABLE review_analysis_cache_entries
  ADD CONSTRAINT review_analysis_cache_canonical_payload_size
  CHECK (
    payload_bytes = octet_length(payload::text)
    AND octet_length(payload::text) BETWEEN 1 AND 1048576
  );
