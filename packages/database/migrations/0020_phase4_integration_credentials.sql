-- Phase 4 / Checkpoint 4.6 — durable organization integration credentials.
--
-- Settings revision and credential generation are intentionally independent.
-- An OAuth refresh can therefore compare-and-swap the generation it read,
-- while disconnect/reconnect advances that generation and makes stale refresh
-- results incapable of resurrecting destroyed credentials.

CREATE TABLE dashboard_integrations (
    id                          UUID PRIMARY KEY,
    organization_id             UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    integration_key             TEXT        NOT NULL,
    status                      TEXT        NOT NULL CHECK (status IN ('connected', 'disconnected', 'error')),
    revision                    BIGINT      NOT NULL DEFAULT 1 CHECK (revision >= 1),
    credential_version          BIGINT      NOT NULL DEFAULT 0 CHECK (credential_version >= 0),
    config                      JSONB       NOT NULL DEFAULT '{}'::jsonb,
    credential_ciphertext       BYTEA,
    credential_nonce            BYTEA,
    credential_key_generation   INTEGER,
    created_at                  TIMESTAMPTZ NOT NULL,
    updated_at                  TIMESTAMPTZ NOT NULL,
    CHECK (
      (credential_ciphertext IS NULL AND credential_nonce IS NULL AND credential_key_generation IS NULL)
      OR
      (credential_ciphertext IS NOT NULL AND credential_nonce IS NOT NULL AND credential_key_generation IS NOT NULL)
    ),
    UNIQUE (organization_id, integration_key)
);

CREATE INDEX dashboard_integrations_org_idx
    ON dashboard_integrations (organization_id, integration_key);

CREATE TABLE dashboard_integration_audit (
    id                  UUID PRIMARY KEY,
    organization_id     UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    integration_id      UUID        NOT NULL REFERENCES dashboard_integrations(id) ON DELETE CASCADE,
    integration_key     TEXT        NOT NULL,
    actor_user_id       UUID        REFERENCES users(id) ON DELETE SET NULL,
    action              TEXT        NOT NULL CHECK (action IN ('connect', 'settings_update', 'credential_rotate', 'disconnect')),
    revision            BIGINT      NOT NULL,
    credential_version  BIGINT      NOT NULL,
    recorded_at         TIMESTAMPTZ NOT NULL
);

CREATE INDEX dashboard_integration_audit_org_idx
    ON dashboard_integration_audit (organization_id, recorded_at DESC, id DESC);

-- Linear authorization attempts are separate from connected integrations.
-- State/browser nonce are one-way hashes; the PKCE verifier is encrypted and
-- bound to the organization + state digest, so a copied row cannot be redeemed
-- for a different authorization attempt.
CREATE TABLE dashboard_linear_oauth_attempts (
    id                        UUID PRIMARY KEY,
    organization_id           UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    actor_user_id              UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    state_hash                CHAR(64)    NOT NULL UNIQUE,
    browser_nonce_hash        CHAR(64)    NOT NULL,
    verifier_ciphertext       BYTEA       NOT NULL,
    verifier_nonce            BYTEA       NOT NULL,
    verifier_key_generation   INTEGER     NOT NULL,
    created_at                TIMESTAMPTZ NOT NULL,
    expires_at                TIMESTAMPTZ NOT NULL,
    consumed_at               TIMESTAMPTZ,
    CHECK (expires_at > created_at),
    CHECK (consumed_at IS NULL OR consumed_at >= created_at)
);

CREATE INDEX dashboard_linear_oauth_attempts_live_idx
    ON dashboard_linear_oauth_attempts (organization_id, expires_at)
    WHERE consumed_at IS NULL;

-- Jira installation uses a show-once capability. The raw capability is never
-- persisted; only its SHA-256 digest survives. Each challenge is bound to the
-- integration revision observed when an administrator created it, so an older
-- installation flow cannot overwrite a newer connection.
CREATE TABLE dashboard_jira_install_challenges (
    id                  UUID PRIMARY KEY,
    organization_id     UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    actor_user_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    secret_hash         CHAR(64)    NOT NULL UNIQUE,
    expected_revision   BIGINT      NOT NULL CHECK (expected_revision >= 0),
    created_at          TIMESTAMPTZ NOT NULL,
    expires_at          TIMESTAMPTZ NOT NULL,
    consumed_at         TIMESTAMPTZ,
    CHECK (expires_at > created_at),
    CHECK (consumed_at IS NULL OR consumed_at >= created_at)
);

CREATE INDEX dashboard_jira_install_challenges_live_idx
    ON dashboard_jira_install_challenges (organization_id, expires_at)
    WHERE consumed_at IS NULL;
