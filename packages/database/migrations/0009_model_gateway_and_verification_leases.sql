-- Phase 2 — stochastic verification needs execution ownership, and model use
-- needs a durable cost ledger.
--
-- 0007 made *scheduling* single-authority: one invocation allocates one attempt
-- ordinal. That is not enough once the verifier is stochastic. Two workers can
-- recover the same scheduled invocation, both call a model, and only discover
-- afterwards that they reached different conclusions. This migration makes
-- execution itself single-flight with a recoverable lease and a fencing token.

-- ---------------------------------------------------------------------------
-- Verification execution lease
-- ---------------------------------------------------------------------------
ALTER TABLE verification_invocations
    DROP CONSTRAINT verification_invocations_state_check;

ALTER TABLE verification_invocations
    ADD COLUMN claim_token UUID,
    ADD COLUMN claim_generation BIGINT NOT NULL DEFAULT 0 CHECK (claim_generation >= 0),
    ADD COLUMN claimed_by TEXT,
    ADD COLUMN claimed_at TIMESTAMPTZ,
    ADD COLUMN claim_expires_at TIMESTAMPTZ;

ALTER TABLE verification_invocations
    ADD CONSTRAINT verification_invocations_state_check
        CHECK (state IN ('scheduled', 'claimed', 'settled'));

-- Existing installations may already have settled commands. Give every such
-- row a synthetic historical claim so the new state invariant is valid before
-- attempt fencing is backfilled. This does not represent a live lease: its
-- expiry is the historical settlement time.
UPDATE verification_invocations
   SET claim_token = id,
       claim_generation = 1,
       claimed_by = 'migration-0009',
       claimed_at = COALESCE(settled_at, created_at),
       claim_expires_at = COALESCE(settled_at, created_at)
 WHERE state = 'settled';

-- Any invocation with a durable attempt is discharged, even if an older
-- process died between recording the attempt and settling the command.
UPDATE verification_invocations AS i
   SET state = 'settled',
       settled_at = COALESCE(i.settled_at, a.created_at),
       claim_token = COALESCE(i.claim_token, i.id),
       claim_generation = CASE WHEN i.claim_generation = 0 THEN 1 ELSE i.claim_generation END,
       claimed_by = COALESCE(i.claimed_by, 'migration-0009'),
       claimed_at = COALESCE(i.claimed_at, a.created_at, i.created_at),
       claim_expires_at = COALESCE(i.claim_expires_at, a.created_at, i.created_at)
  FROM verification_attempts AS a
 WHERE a.invocation_id = i.id;

ALTER TABLE verification_invocations
    ADD CONSTRAINT verification_invocation_claim_shape CHECK (
        (state = 'scheduled'
          AND claim_token IS NULL
          AND claimed_by IS NULL
          AND claimed_at IS NULL
          AND claim_expires_at IS NULL)
        OR
        (state IN ('claimed', 'settled')
          AND claim_token IS NOT NULL
          AND claimed_by IS NOT NULL
          AND claimed_at IS NOT NULL
          AND claim_expires_at IS NOT NULL)
    );

ALTER TABLE verification_invocations
    ADD CONSTRAINT verification_invocations_claim_fence_uq
        UNIQUE (id, claim_token, claim_generation);

CREATE INDEX verification_invocations_recoverable_idx
    ON verification_invocations (review_run_id, claim_expires_at)
    WHERE state IN ('scheduled', 'claimed');

ALTER TABLE verification_attempts
    ADD COLUMN claim_token UUID,
    ADD COLUMN claim_generation BIGINT;

UPDATE verification_attempts AS a
   SET claim_token = i.claim_token,
       claim_generation = i.claim_generation
  FROM verification_invocations AS i
 WHERE i.id = a.invocation_id;

ALTER TABLE verification_attempts
    ALTER COLUMN claim_token SET NOT NULL,
    ALTER COLUMN claim_generation SET NOT NULL;

ALTER TABLE verification_attempts
    ADD CONSTRAINT verification_attempts_from_live_claim
        FOREIGN KEY (invocation_id, claim_token, claim_generation)
        REFERENCES verification_invocations (id, claim_token, claim_generation);

-- ---------------------------------------------------------------------------
-- Model interaction ledger
-- ---------------------------------------------------------------------------
CREATE TABLE model_interactions (
    id                      UUID PRIMARY KEY,
    organization_id         UUID        NOT NULL REFERENCES organizations(id),
    review_run_id           UUID        NOT NULL REFERENCES review_runs(id) ON DELETE CASCADE,
    request_digest          CHAR(64)    NOT NULL,
    provider                TEXT        NOT NULL CHECK (provider IN ('openai', 'anthropic')),
    model_id                TEXT        NOT NULL,
    task_class              TEXT        NOT NULL CHECK (task_class IN ('triage', 'correctness', 'verification', 'summary')),
    tier                    TEXT        NOT NULL CHECK (tier IN ('cheap', 'strong')),
    routing_policy_version  TEXT        NOT NULL,
    prompt_template_version TEXT        NOT NULL,
    outcome                 TEXT        NOT NULL CHECK (outcome IN ('ok', 'failed', 'unknown', 'invalid_response')),
    input_tokens            BIGINT      NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
    output_tokens           BIGINT      NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
    cached_input_tokens     BIGINT      NOT NULL DEFAULT 0 CHECK (cached_input_tokens >= 0),
    cost_microusd           BIGINT      NOT NULL DEFAULT 0 CHECK (cost_microusd >= 0),
    cache_hit               BOOLEAN     NOT NULL DEFAULT FALSE,
    replayed                BOOLEAN     NOT NULL DEFAULT FALSE,
    provider_dispatched     BOOLEAN     NOT NULL DEFAULT FALSE,
    started_at              TIMESTAMPTZ NOT NULL,
    finished_at             TIMESTAMPTZ NOT NULL,
    CONSTRAINT model_interaction_time_order CHECK (finished_at >= started_at)
);

CREATE INDEX model_interactions_run_idx
    ON model_interactions (review_run_id, started_at);
CREATE INDEX model_interactions_org_idx
    ON model_interactions (organization_id, started_at);

-- Fleet-wide provider credential admission. The credential id is an opaque
-- deployment label, never secret material. Released rows remain for the
-- rolling one-minute rate window; expired active rows stop consuming
-- concurrency after a crashed worker.
CREATE TABLE model_credential_admissions (
    id                UUID PRIMARY KEY,
    credential_id     TEXT        NOT NULL,
    admitted_at       TIMESTAMPTZ NOT NULL,
    lease_expires_at  TIMESTAMPTZ NOT NULL,
    released_at       TIMESTAMPTZ,
    CONSTRAINT model_credential_admission_time_order
        CHECK (lease_expires_at > admitted_at),
    CONSTRAINT model_credential_release_order
        CHECK (released_at IS NULL OR released_at >= admitted_at)
);

CREATE INDEX model_credential_admissions_active_idx
    ON model_credential_admissions (credential_id, lease_expires_at)
    WHERE released_at IS NULL;
CREATE INDEX model_credential_admissions_rate_idx
    ON model_credential_admissions (credential_id, admitted_at);
