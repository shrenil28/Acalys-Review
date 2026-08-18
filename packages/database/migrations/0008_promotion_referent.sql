-- The last rule that was still only a rule.
--
-- After 0007 the funnel is structural at three of its four joints:
--
--     an attempt   requires a scheduled invocation   composite foreign key
--     a comment    requires a `publish` decision     foreign key to a column
--                                                    that exists only for
--                                                    `publish`
--     a merge block cannot see publication state     no column, no import
--
-- The fourth was not. `review_findings.verification_attempt_id` was nullable,
-- and it referenced `verification_attempts(id)` — every attempt, including the
-- rejected, the inconclusive and the unavailable ones. So this was accepted:
--
--     INSERT INTO review_findings (…, verification_attempt_id)
--     VALUES (…, <the id of an attempt that REJECTED the claim>);
--
-- `VerificationStore.promote` refuses it, and `findLifecycleViolations` reports
-- it afterwards. Both are real, and neither is the guarantee: the first is code
-- a second writer can skip — which is exactly what the orchestrator did for
-- three checkpoints — and the second is a report, which by definition arrives
-- after the row exists.
--
-- The referent trick from `publication_decisions` applies unchanged. A column
-- that is NULL for every attempt except a verified one cannot be pointed at by
-- a foreign key unless the attempt verified the claim.

-- Non-null only for a completed attempt that verified. `status` is in the
-- expression as well as `decision`: the CHECK in 0006 already forbids a
-- decision on an unavailable row, and repeating the condition here means this
-- column stays correct even if that CHECK is ever relaxed.
ALTER TABLE verification_attempts
    ADD COLUMN verified_id UUID
        GENERATED ALWAYS AS (
            CASE WHEN status = 'completed' AND decision = 'verified' THEN id END
        ) STORED;

CREATE UNIQUE INDEX verification_attempts_verified_uq
    ON verification_attempts (verified_id);

-- Repoint the promotion reference at the verified-only column.
--
-- Development databases may hold findings written before 0006, whose
-- `verification_attempt_id` is NULL. They are exactly the rows the entailment
-- calls violations, and carrying them forward would mean the NOT NULL below
-- could never be added — so they are removed rather than preserved. Nothing in
-- production has run this pipeline.
DELETE FROM review_findings WHERE verification_attempt_id IS NULL;

ALTER TABLE review_findings
    DROP CONSTRAINT review_findings_verification_attempt_id_fkey;

ALTER TABLE review_findings
    ADD CONSTRAINT review_findings_promoted_by_verification
        FOREIGN KEY (verification_attempt_id)
        REFERENCES verification_attempts (verified_id);

-- And a finding must cite one at all.
--
-- Nullable was the right call in 0006, when the store was the only writer and
-- older rows existed. It is the wrong call now: a nullable column is a column a
-- future writer can omit, and the writer that omitted it last time was the
-- production orchestrator.
ALTER TABLE review_findings
    ALTER COLUMN verification_attempt_id SET NOT NULL;
