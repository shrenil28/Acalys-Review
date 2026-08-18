-- The trust funnel, made structural.
--
-- 0006 gave verification its own durable rows and wrote the entailments that
-- describe the trust boundary. It did not make the boundary *unavoidable*, and
-- a probe against the live orchestrator showed exactly what that costs:
--
--     candidate_findings              2
--     verifications      (legacy)     2
--     verification_attempts           0      ← the P1-I table, never written
--     review_findings                 2      ← verification_attempt_id NULL
--     publication_intents             3      ← one comment per finding, no policy
--
-- Every gate was green. `findLifecycleViolations` already contained the two
-- queries that catch this, and reported four violations the moment it was
-- pointed at a run the orchestrator had actually driven — it had only ever been
-- called against a fixture with no candidates and no findings, where both
-- queries are vacuously satisfied.
--
-- So the lesson is not "wire it up". It is that a boundary enforced by which
-- function a worker happens to call is not a boundary. This migration moves
-- each step of the funnel behind something the database will not let a caller
-- skip:
--
--     an attempt      cannot exist without a durably scheduled invocation
--     a finding       cannot exist without a verified attempt   (0006, kept)
--     a comment       cannot exist without a `publish` decision
--     a merge block   cannot be read off publication state at all

-- ---------------------------------------------------------------------------
-- Who allocates the next attempt ordinal
-- ---------------------------------------------------------------------------
--
-- 0006 made the ordinal *supplied* rather than computed, which was right as far
-- as it went: `MAX(attempt) + 1` in the worker is a race, and losing that race
-- masquerades as a redelivery — the one distinction the invocation id exists to
-- protect. But "supplied by the caller" only moves the authority somewhere with
-- no durable record of what it decided, so two schedulers could still originate
-- the same ordinal and the database would learn about it as a constraint
-- violation, i.e. as contention rather than as a domain fact.
--
-- The authority is now a durable row, allocated under a lock on the candidate
-- (see `VerificationScheduler`). `MAX(attempt) + 1` is safe *there* and nowhere
-- else, because the lock makes concurrent schedulers serial: the second one
-- reads a table the first has already written, and decides "redelivery or new
-- attempt" by reading `request_key`, never by catching a unique violation.
--
-- Contention blocks. It never decides.
CREATE TABLE verification_invocations (
    -- This *is* the invocation id carried on the attempt. One row, one logical
    -- verification, minted before the verifier runs.
    id                    UUID PRIMARY KEY,
    organization_id       UUID        NOT NULL REFERENCES organizations(id),
    review_run_id         UUID        NOT NULL REFERENCES review_runs(id) ON DELETE CASCADE,
    candidate_finding_id  UUID        NOT NULL REFERENCES candidate_findings(id) ON DELETE CASCADE,

    attempt               INTEGER     NOT NULL CHECK (attempt >= 1),

    -- What the caller was asking for, in the caller's own terms.
    --
    -- This is the redelivery discriminator, and it is a *domain* value: "the
    -- first verification pass of candidate C in run R" is one request however
    -- many times a queue delivers it. A second delivery presents the same key
    -- and converges; an operator re-verifying after fixing the verifier
    -- presents a different one and gets a new ordinal.
    --
    -- Deliberately not the delivery id, the job id, or anything else the
    -- transport mints: those change per delivery, which is precisely what makes
    -- them useless for telling deliveries apart from retries.
    request_key           TEXT        NOT NULL,

    -- Why a second attempt exists at all. Kept because "how often do we
    -- re-verify, and what prompted it?" is unanswerable from ordinals alone,
    -- and because a retry storm and a deliberate re-verification campaign look
    -- identical in a count.
    reason                TEXT        NOT NULL
                          CHECK (reason IN ('initial', 'retry_unavailable', 'operator_reverify')),

    -- `scheduled` means the command is recoverable: a worker that crashed
    -- before executing leaves it here, and any worker may pick it up. It does
    -- NOT mean a worker is alive — the same reason `attempting` does not, in
    -- the publication ledger.
    state                 TEXT        NOT NULL
                          CHECK (state IN ('scheduled', 'settled')),

    created_at            TIMESTAMPTZ NOT NULL,
    settled_at            TIMESTAMPTZ,

    CONSTRAINT verification_invocation_settled_has_time
        CHECK (state <> 'settled' OR settled_at IS NOT NULL),

    -- The allocation itself. Two schedulers cannot both originate attempt N.
    UNIQUE (candidate_finding_id, attempt),

    -- Redelivery converges here rather than in the attempts table, so
    -- convergence happens *before* the expensive part runs.
    UNIQUE (request_key)
);

-- The target of the composite foreign key below. `id` is already the primary
-- key; this exists so an attempt can be tied to the *whole* allocation rather
-- than to the invocation alone.
ALTER TABLE verification_invocations
    ADD CONSTRAINT verification_invocations_allocation_uq
        UNIQUE (id, candidate_finding_id, attempt);

CREATE INDEX verification_invocations_run_idx
    ON verification_invocations (review_run_id);

-- Commands a crashed worker left behind. The recovery queue.
CREATE INDEX verification_invocations_scheduled_idx
    ON verification_invocations (review_run_id)
    WHERE state = 'scheduled';

-- # An attempt cannot invent its own identity
--
-- The composite key is the point. A single-column FK on `invocation_id` would
-- let an attempt cite a real invocation while claiming a different candidate or
-- a different ordinal — which is exactly the corruption the ordinal exists to
-- prevent, arriving through the column that was supposed to prevent it.
--
-- With all three, "this attempt is attempt N of candidate C" is true because
-- the scheduler allocated it, not because a worker passed three arguments that
-- happened to agree.
ALTER TABLE verification_attempts
    ADD CONSTRAINT verification_attempts_from_invocation
        FOREIGN KEY (invocation_id, candidate_finding_id, attempt)
        REFERENCES verification_invocations (id, candidate_finding_id, attempt);

-- ---------------------------------------------------------------------------
-- The legacy verification table goes
-- ---------------------------------------------------------------------------
--
-- `verifications` (0003) was the P1-E.2 stub's store, and it is not merely
-- superseded — it contradicts the invariant P1-I is built on. `UNIQUE
-- (candidate_finding_id)` with `ON CONFLICT DO NOTHING` means a second
-- verification of a candidate is silently discarded, so the history that makes
-- "verifier v4 rejected it, v5 verified it after a bug fix" answerable cannot
-- be recorded at all.
--
-- Leaving it in place as "the old one, unused" is how the orchestrator came to
-- be writing to it while every P1-I guarantee was asserted about the other
-- table. Two tables answering one question is not redundancy; it is a choice
-- someone will make wrongly.
DROP TABLE verifications;

-- ---------------------------------------------------------------------------
-- A comment requires a decision that says to publish
-- ---------------------------------------------------------------------------
--
-- Publication policy answers a question verification does not: *this defect is
-- real — should a developer be interrupted about it, on this surface?* A
-- verified finding may legitimately be withheld, and the decision has to be
-- durable for the same reason the rejections are: "why did it go quiet?" is
-- asked as often as "why did it comment?", and neither is answerable from rows
-- that only record what was published.
CREATE TABLE publication_decisions (
    id                  UUID        PRIMARY KEY,
    organization_id     UUID        NOT NULL REFERENCES organizations(id),
    review_run_id       UUID        NOT NULL REFERENCES review_runs(id) ON DELETE CASCADE,
    review_finding_id   UUID        NOT NULL REFERENCES review_findings(id) ON DELETE CASCADE,

    -- Which attention surface this decides. A finding may be worth a PR comment
    -- and not worth an IDE interruption, so the decision is per surface rather
    -- than per finding.
    surface             TEXT        NOT NULL CHECK (surface IN ('pull_request_comment')),

    decision            TEXT        NOT NULL CHECK (decision IN ('publish', 'withhold')),
    -- Closed vocabulary, mirroring `PUBLICATION_REASONS`. Free text would make
    -- "why is this bot quiet?" unaggregatable.
    reason              TEXT        NOT NULL,
    decided_at          TIMESTAMPTZ NOT NULL,

    -- One decision per finding per surface, so re-running policy converges
    -- instead of accumulating a decision per worker attempt.
    UNIQUE (review_finding_id, surface),

    -- # The referent that only exists for `publish`
    --
    -- NULL for a withheld decision, and a foreign key cannot reference NULL. So
    -- a withheld decision is not merely *not referenced* by a publication — it
    -- is unreferenceable, and "withheld finding still reached the ledger"
    -- stops being a rule someone remembers.
    publishable_id      UUID
        GENERATED ALWAYS AS (CASE WHEN decision = 'publish' THEN id END) STORED
);

CREATE UNIQUE INDEX publication_decisions_publishable_uq
    ON publication_decisions (publishable_id);

CREATE INDEX publication_decisions_run_idx
    ON publication_decisions (review_run_id);

-- Which decision authorized this publication.
--
-- `authored_by = 'policy'` (0006) constrains a *string*. Any INSERT that omits
-- the column gets it from the default and satisfies the CHECK, which is how the
-- orchestrator has been writing rows that policy never saw while the constraint
-- reported the trust boundary intact. This column is the same claim with a
-- referent: not "policy wrote this" but "here is the decision, and it says
-- publish".
ALTER TABLE publication_intents
    ADD COLUMN publication_decision_id UUID
        REFERENCES publication_decisions (publishable_id);

-- Run-level publications — the review container, the summary, the check — are
-- not about one finding and carry no decision. Finding-scoped ones must.
ALTER TABLE publication_intents
    ADD CONSTRAINT publication_intents_finding_needs_decision
        CHECK (review_finding_id IS NULL OR publication_decision_id IS NOT NULL);

-- ---------------------------------------------------------------------------
-- Enforcement is not attention
-- ---------------------------------------------------------------------------
--
-- The same verified finding branches into two independent surfaces:
--
--                        ReviewFinding
--                       /             \
--        publication policy           pre-merge policy
--               ↓                            ↓
--        developer attention             enforcement
--               ↓                            ↓
--        comment / summary               check result
--
-- All three combinations are legitimate and each has a real use: comment and
-- block, comment without blocking (most findings), and block without commenting
-- (a policy failure the PR check reports, with nothing useful to say inline).
--
-- The separation is structural: this table has no column referencing
-- `publication_intents` or `publication_decisions`, and no view derives one from
-- the other. `published == merge_blocking` cannot be encoded because there is
-- nothing here to encode it with.
--
-- Shape follows the Phase 0 `PreMergeCheckResult` contract, including the part
-- that matters most: a status, never a severity. Expressing "three high
-- findings" as a check with a severity is how severity starts meaning
-- "blocking" and policy gets tuned by re-grading defects.
CREATE TABLE premerge_check_results (
    id                  UUID        PRIMARY KEY,
    organization_id     UUID        NOT NULL REFERENCES organizations(id),
    repository_id       UUID        NOT NULL REFERENCES repositories(id),
    review_run_id       UUID        NOT NULL REFERENCES review_runs(id) ON DELETE CASCADE,

    check_id            TEXT        NOT NULL,
    name                TEXT        NOT NULL,

    status              TEXT        NOT NULL
                        CHECK (status IN ('pending', 'running', 'passed',
                                          'failed', 'inconclusive', 'skipped')),
    explanation         TEXT,

    -- A property of the check's *configuration*, recorded on the result so the
    -- result stays interpretable after the configuration changes.
    blocking            BOOLEAN     NOT NULL,

    evaluated_at        TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL,

    -- A settled check knows when it settled; an unsettled one cannot.
    CONSTRAINT premerge_settled_is_evaluated
        CHECK (status IN ('pending', 'running') OR evaluated_at IS NOT NULL),
    CONSTRAINT premerge_unsettled_is_not_evaluated
        CHECK (status NOT IN ('pending', 'running') OR evaluated_at IS NULL),
    -- A developer shown `failed` with no reason cannot act on it.
    CONSTRAINT premerge_needs_explanation
        CHECK (status NOT IN ('failed', 'inconclusive', 'skipped')
               OR explanation IS NOT NULL),

    UNIQUE (review_run_id, check_id)
);

CREATE INDEX premerge_check_results_run_idx
    ON premerge_check_results (review_run_id);
