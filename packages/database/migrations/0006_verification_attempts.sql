-- Verification as its own durable fact.
--
-- The tempting shape is to update the candidate row with its verification
-- result. It loses the history that makes the system improvable:
--
--     analyzer v7   → candidate X
--     verifier v4   → rejected
--     verifier v5   → verified        (after a verifier bug was fixed)
--
-- If the candidate had been mutated into its result, "what changed, and was the
-- old answer wrong?" is unanswerable. So three separate durable facts:
--
--     candidate_findings      what an analyzer claimed
--     verification_attempts   what verification concluded, per attempt
--     review_findings         what Acalys is willing to stand behind
--
-- `CandidateFinding != ReviewFinding` is a runtime property here, not only a
-- TypeScript one.

CREATE TABLE verification_attempts (
    id                    UUID PRIMARY KEY,
    organization_id       UUID        NOT NULL REFERENCES organizations(id),
    review_run_id         UUID        NOT NULL REFERENCES review_runs(id) ON DELETE CASCADE,
    candidate_finding_id  UUID        NOT NULL REFERENCES candidate_findings(id) ON DELETE CASCADE,

    -- Two disjoint vocabularies, never one column with a fourth value.
    -- `unavailable` is infrastructure state; a decision is epistemic state, and
    -- mixing them lets an outage be counted as a rejection.
    status                TEXT        NOT NULL CHECK (status IN ('completed', 'unavailable')),
    decision              TEXT        CHECK (decision IN ('verified', 'rejected', 'inconclusive')),
    reasons               TEXT[]      NOT NULL DEFAULT '{}',
    confidence            NUMERIC(4,3) CHECK (confidence >= 0 AND confidence <= 1),
    severity              TEXT,
    -- Why verification could not run. Never a decision.
    failure               TEXT,

    verifier_id           TEXT        NOT NULL,
    verifier_version      TEXT        NOT NULL,
    -- Model-independent digest of the context the VERIFIER planned for itself.
    context_digest        CHAR(64)    NOT NULL,
    -- Built from the claim and the verifier's procedure, and from nothing about
    -- the analyzer. Two candidates carrying one claim share this key.
    cache_key             CHAR(64)    NOT NULL,

    -- Which attempt this is for this candidate, from 1.
    --
    -- Causality has to survive retries: "the same candidate, verified a second
    -- time under a fixed verifier" and "a new candidate that happens to share a
    -- fingerprint" are different histories, and a funnel derived from rows that
    -- cannot tell them apart will double-count one and lose the other.
    attempt               INTEGER     NOT NULL DEFAULT 1 CHECK (attempt >= 1),

    created_at            TIMESTAMPTZ NOT NULL,

    -- A completed attempt must say what it decided and why. "Verified, reason
    -- unknown" is a row nobody can audit, and it is written by exactly the code
    -- path that is in a hurry.
    --
    -- `cardinality`, not `array_length`. `array_length('{}', 1)` returns NULL,
    -- `NULL >= 1` is NULL, and a CHECK only fails on FALSE — so the empty case
    -- passed. The test caught it; the first draft of this constraint enforced
    -- nothing for exactly the input it was written for.
    CONSTRAINT verification_completed_is_reasoned CHECK (
        status <> 'completed'
        OR (decision IS NOT NULL AND severity IS NOT NULL AND cardinality(reasons) >= 1)
    ),

    -- An unavailable attempt has not examined anything. It must carry a failure
    -- and must NOT carry a decision, so no reader can mistake it for a
    -- judgement about the claim.
    CONSTRAINT verification_unavailable_has_no_decision CHECK (
        status <> 'unavailable'
        OR (failure IS NOT NULL AND decision IS NULL)
    )
);

-- Idempotency for the verification stage: the same claim re-verified under the
-- same procedure and context converges on one row rather than accumulating one
-- per worker retry.
CREATE UNIQUE INDEX verification_attempts_identity_uq
    ON verification_attempts (candidate_finding_id, cache_key);

-- Attempts are numbered per candidate, so the sequence is a fact in the data
-- rather than something reconstructed from timestamps that may tie.
CREATE UNIQUE INDEX verification_attempts_sequence_uq
    ON verification_attempts (candidate_finding_id, attempt);

CREATE INDEX verification_attempts_run_idx
    ON verification_attempts (review_run_id);

-- Candidates still awaiting a completed verification. The working set for the
-- entailment that `reconciling` and beyond require every candidate to have been
-- examined.
CREATE INDEX verification_attempts_unavailable_idx
    ON verification_attempts (review_run_id)
    WHERE status = 'unavailable';

-- # Who may author a publication
--
-- The analyzer may not. The verifier may not. Only the reconciliation and
-- policy path has that authority, and the database says so rather than a code
-- review remembering it.
--
-- Without this, the shortest path from "an analyzer had an opinion" to "a
-- developer was interrupted" is one INSERT, and every guarantee upstream of it
-- becomes decorative.
-- The default stays. The CHECK is what enforces authority, and dropping the
-- default would only mean every legitimate insert has to name it — which makes
-- the column feel enforced while the guarantee still comes entirely from the
-- constraint.
ALTER TABLE publication_intents
    ADD COLUMN authored_by TEXT NOT NULL DEFAULT 'policy'
        CHECK (authored_by = 'policy');

-- Which finding a publication renders, so the trust chain is walkable in SQL:
--
--     publication → review_finding → verification_attempt → candidate
--
-- Nullable because the run-level summary publication belongs to no single
-- finding.
ALTER TABLE publication_intents
    ADD COLUMN review_finding_id UUID REFERENCES review_findings(id);

-- # Promotion requires a verification
--
-- A review finding must point at the attempt that established it. Nullable only
-- because rows written before this migration exist in development databases;
-- the store refuses to write one without it.
ALTER TABLE review_findings
    ADD COLUMN verification_attempt_id UUID REFERENCES verification_attempts(id);

CREATE INDEX review_findings_verification_idx
    ON review_findings (verification_attempt_id);
