-- What the review actually covered.
--
-- Without this, a review that hit a budget cap and a review that found nothing
-- are indistinguishable in the database — both are a `completed` run with no
-- findings. They are materially different claims:
--
--     analysis completed                     "we looked, and it is clean"
--     analysis completed with bounded cover   "we looked at part of it"
--
-- Every quality number computed over the second while believing the first is
-- wrong in an unknown direction, and nobody can tell afterwards which reviews
-- were which.
--
-- Nullable because a run that has not reached analysis has nothing to report,
-- and a zero would claim it analyzed nothing rather than that it has not begun.
ALTER TABLE review_runs
    ADD COLUMN analysis_clusters_total    INTEGER
        CHECK (analysis_clusters_total >= 0),
    ADD COLUMN analysis_clusters_analyzed INTEGER
        CHECK (analysis_clusters_analyzed >= 0),
    ADD COLUMN analysis_clusters_skipped  INTEGER
        CHECK (analysis_clusters_skipped >= 0),
    ADD COLUMN analysis_context_tokens    INTEGER
        CHECK (analysis_context_tokens >= 0),
    -- Null when coverage was complete. A value means the review stopped early,
    -- and names why in the same vocabulary the engine reports.
    ADD COLUMN analysis_stop_reason       TEXT,
    ADD COLUMN analysis_complete          BOOLEAN;

-- Coverage is all-or-nothing as a record: a row that reports some of it and not
-- the rest cannot be interpreted, and a partially-written record is worse than
-- an absent one because it looks answerable.
ALTER TABLE review_runs
    ADD CONSTRAINT review_runs_coverage_is_whole
        CHECK (
            (analysis_complete IS NULL
             AND analysis_clusters_total IS NULL
             AND analysis_clusters_analyzed IS NULL
             AND analysis_clusters_skipped IS NULL)
            OR
            (analysis_complete IS NOT NULL
             AND analysis_clusters_total IS NOT NULL
             AND analysis_clusters_analyzed IS NOT NULL
             AND analysis_clusters_skipped IS NOT NULL)
        );

-- An incomplete review must say why. "Bounded coverage, reason unknown" is a
-- record nobody can act on.
ALTER TABLE review_runs
    ADD CONSTRAINT review_runs_incomplete_has_reason
        CHECK (analysis_complete IS NOT FALSE OR analysis_stop_reason IS NOT NULL);
