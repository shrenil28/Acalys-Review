-- Stage outputs: what each step of a run durably produced.
--
-- The design question this schema answers, and the review that forced it:
--
-- > Is a stage's work and its state transition one transaction, or two?
--
-- Two would allow the state machine to lie. `state = 'verifying'` would mean
-- "a worker transitioned", not "analysis output exists" — and a crash between
-- the two commits leaves a run whose state claims a stage happened while its
-- artifact is missing. The next worker reads the enum, believes it, and
-- proceeds on nothing.
--
-- That is the compare-and-swap bug one layer up: an enum is not evidence.
--
-- **So they are one transaction.** A stage's output and the transition that
-- announces it commit together or not at all. `state = 'verifying'` therefore
-- *entails* that analysis output exists, and the invariant is structural rather
-- than a rule someone remembers.
--
-- The prerequisite checks in the store are defence in depth, not the primary
-- guarantee — they exist because a schema can be corrupted by hand, a migration
-- can be wrong, and a future refactor can split what is currently atomic.
--
-- # Idempotent by identity, not by insertion
--
-- Every table below is keyed so that re-running a stage *converges*:
--
--     candidate    UNIQUE (review_run_id, fingerprint_value)
--     verification UNIQUE (candidate_finding_id)
--     finding      UNIQUE (review_run_id, fingerprint_value)
--     publication  UNIQUE (review_run_id, logical_key)
--
-- A retried stage means "ensure the output for this identity exists", never
-- "insert output". With a deterministic analyzer that distinction is easy to
-- verify: duplicate rows are immediately visible.

CREATE TABLE candidate_findings (
    id                  UUID PRIMARY KEY,
    organization_id     UUID        NOT NULL REFERENCES organizations(id),
    repository_id       UUID        NOT NULL REFERENCES repositories(id),
    review_run_id       UUID        NOT NULL REFERENCES review_runs(id) ON DELETE CASCADE,

    -- Which analyzer, at which version, produced this. Part of provenance and
    -- part of reproducibility: the same run re-analyzed by a different version
    -- is a different claim, even for the same fingerprint.
    producer_id         TEXT        NOT NULL,
    producer_version    TEXT        NOT NULL,
    -- Digest of what the analyzer was given. The seed of the context-provenance
    -- work in P1-CONTEXT; here it only proves determinism.
    input_digest        CHAR(64)    NOT NULL,

    title               TEXT        NOT NULL,
    claim               TEXT        NOT NULL,
    explanation         TEXT        NOT NULL,
    category            TEXT        NOT NULL,
    proposed_severity   TEXT        NOT NULL,

    path                TEXT        NOT NULL,
    start_line          INTEGER     NOT NULL CHECK (start_line >= 1),
    end_line            INTEGER     NOT NULL CHECK (end_line >= start_line),

    -- Identity that survives line movement (§28). The convergence key.
    fingerprint_value   CHAR(64)    NOT NULL,

    created_at          TIMESTAMPTZ NOT NULL,

    UNIQUE (review_run_id, fingerprint_value)
);

CREATE INDEX candidate_findings_run_idx ON candidate_findings (review_run_id);

-- Verification is an independent decision (§32), so it is a separate row with
-- its own producer identity — not a column on the candidate. One per candidate:
-- a second verification of the same candidate is a re-decision, and re-deciding
-- silently is how a verifier's disagreement with itself becomes invisible.
CREATE TABLE verifications (
    id                    UUID PRIMARY KEY,
    organization_id       UUID        NOT NULL REFERENCES organizations(id),
    review_run_id         UUID        NOT NULL REFERENCES review_runs(id) ON DELETE CASCADE,
    candidate_finding_id  UUID        NOT NULL REFERENCES candidate_findings(id) ON DELETE CASCADE,

    decision              TEXT        NOT NULL
                          CHECK (decision IN ('verified','rejected','inconclusive')),
    reason_codes          JSONB       NOT NULL,
    confidence_score      NUMERIC(4,3) NOT NULL CHECK (confidence_score BETWEEN 0 AND 1),
    confidence_level      TEXT        NOT NULL,

    verifier_id           TEXT        NOT NULL,
    verifier_version      TEXT        NOT NULL,
    created_at            TIMESTAMPTZ NOT NULL,

    UNIQUE (candidate_finding_id)
);

CREATE INDEX verifications_run_idx ON verifications (review_run_id);

-- A published finding. Separate from its candidate because they are different
-- types with different fields (§27) — and because a rejected candidate must
-- have no row here at all, which makes "a published finding is not a rejected
-- candidate" structural rather than a check.
CREATE TABLE review_findings (
    id                  UUID PRIMARY KEY,
    organization_id     UUID        NOT NULL REFERENCES organizations(id),
    repository_id       UUID        NOT NULL REFERENCES repositories(id),
    review_run_id       UUID        NOT NULL REFERENCES review_runs(id) ON DELETE CASCADE,
    revision_id         UUID        REFERENCES pull_request_revisions(id),

    fingerprint_value   CHAR(64)    NOT NULL,
    severity            TEXT        NOT NULL,
    category            TEXT        NOT NULL,
    confidence_score    NUMERIC(4,3) NOT NULL,
    confidence_level    TEXT        NOT NULL,

    title               TEXT        NOT NULL,
    explanation         TEXT        NOT NULL,
    path                TEXT        NOT NULL,
    start_line          INTEGER     NOT NULL,
    end_line            INTEGER     NOT NULL,

    state               TEXT        NOT NULL
                        CHECK (state IN ('verified','published','resolved',
                                         'dismissed','stale','superseded')),
    created_at          TIMESTAMPTZ NOT NULL,
    updated_at          TIMESTAMPTZ NOT NULL,

    UNIQUE (review_run_id, fingerprint_value)
);

-- Incremental review's join key (§29): "is this the same finding we reported
-- last revision?" is a lookup on this index, once per candidate per run.
CREATE INDEX review_findings_lineage_idx
    ON review_findings (repository_id, fingerprint_value);

-- The publication ledger.
--
-- Deliberately an INTENT, not a record of success. The distinction is the whole
-- point, and `unknown` is the state that makes it necessary:
--
--     planned     we mean to publish this
--     attempting  a request is in flight
--     unknown     the outcome was ambiguous — a timeout tells us we do not know
--                 whether the provider committed it, NOT that it did not
--     published   the provider definitely contains it
--     failed      the provider definitely rejected it
--
-- Collapsing `unknown` into `failed` is how duplicate comments happen: the
-- retry posts a second copy of something already there.
--
-- `content_digest` is stored alongside `logical_key` because they answer
-- different questions. Same key with a changed digest means a deploy altered
-- the text under a stable identity — an invariant violation unless an explicit
-- update protocol exists, because "the provider has marker X" would no longer
-- tell us it has the intended X.
CREATE TABLE publication_intents (
    id                  UUID PRIMARY KEY,
    organization_id     UUID        NOT NULL REFERENCES organizations(id),
    review_run_id       UUID        NOT NULL REFERENCES review_runs(id) ON DELETE CASCADE,

    kind                TEXT        NOT NULL
                        CHECK (kind IN ('review','inline_comment','summary','check')),
    -- Stable across retries and across processes. Minted BEFORE any provider
    -- call, so an ambiguous outcome is still reconcilable.
    logical_key         TEXT        NOT NULL,
    content_digest      CHAR(64)    NOT NULL,

    state               TEXT        NOT NULL
                        CHECK (state IN ('planned','attempting','unknown','published','failed')),

    provider_reference  TEXT,
    attempts            INTEGER     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    last_error_code     TEXT,

    created_at          TIMESTAMPTZ NOT NULL,
    updated_at          TIMESTAMPTZ NOT NULL,

    UNIQUE (review_run_id, logical_key)
);

-- Reconciliation's working set: anything not definitively settled needs a
-- provider lookup before it can be retried.
CREATE INDEX publication_intents_unsettled_idx
    ON publication_intents (review_run_id)
    WHERE state IN ('planned', 'attempting', 'unknown');
