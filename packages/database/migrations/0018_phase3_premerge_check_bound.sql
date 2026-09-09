-- Phase 3: the frozen pre-merge-check route has no cursor query, while its
-- PageDto response is capped at 100 items. Enforce that shape in persistence so
-- the API can never leak an unusable raw continuation id or silently truncate a
-- larger result set.

DO $$
BEGIN
  IF EXISTS (
    SELECT review_run_id
      FROM premerge_check_results
     GROUP BY review_run_id
    HAVING COUNT(*) > 100
  ) THEN
    RAISE EXCEPTION 'pre-merge check result count exceeds the frozen API bound'
      USING ERRCODE = '23514', CONSTRAINT = 'premerge_check_results_run_limit';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION enforce_premerge_check_result_limit()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  existing_count integer;
BEGIN
  -- Serialize distinct check insertion for one run across writer replicas. The
  -- ON CONFLICT update path is allowed at the cap because it does not increase
  -- the externally visible collection cardinality.
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.review_run_id::text, 1803));

  IF EXISTS (
    SELECT 1
      FROM premerge_check_results
     WHERE review_run_id = NEW.review_run_id
       AND check_id = NEW.check_id
  ) THEN
    RETURN NEW;
  END IF;

  SELECT COUNT(*)::integer
    INTO existing_count
    FROM premerge_check_results
   WHERE review_run_id = NEW.review_run_id;

  IF existing_count >= 100 THEN
    RAISE EXCEPTION 'a review run may expose at most 100 pre-merge check results'
      USING ERRCODE = '23514', CONSTRAINT = 'premerge_check_results_run_limit';
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS premerge_check_results_run_limit_trigger
  ON premerge_check_results;
CREATE TRIGGER premerge_check_results_run_limit_trigger
BEFORE INSERT ON premerge_check_results
FOR EACH ROW EXECUTE FUNCTION enforce_premerge_check_result_limit();
