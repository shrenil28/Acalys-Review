-- Phase 3: authentication, authorization, API idempotency and live read models.
--
-- Tenant keys are deliberately denormalized on every tenant-scoped row. API
-- query methods require organization_id and every index starts with it where
-- the access path is tenant-scoped. A caller-supplied resource id is never a
-- substitute for tenant identity.

ALTER TABLE organizations
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE repositories
    ADD COLUMN IF NOT EXISTS lifecycle TEXT NOT NULL DEFAULT 'active'
      CHECK (lifecycle IN ('active','disabled','archived'));

ALTER TABLE review_findings
    ADD COLUMN IF NOT EXISTS evidence_count INTEGER NOT NULL DEFAULT 0 CHECK (evidence_count >= 0),
    ADD COLUMN IF NOT EXISTS suggested_fix_id UUID;

CREATE TABLE IF NOT EXISTS users (
    id             UUID PRIMARY KEY,
    provider       TEXT NOT NULL DEFAULT 'github',
    provider_user_id TEXT NOT NULL,
    primary_email  TEXT,
    display_name   TEXT,
    created_at     TIMESTAMPTZ NOT NULL,
    updated_at     TIMESTAMPTZ NOT NULL,
    UNIQUE (provider, provider_user_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS users_email_uq
    ON users (lower(primary_email)) WHERE primary_email IS NOT NULL;

CREATE TABLE IF NOT EXISTS memberships (
    id               UUID PRIMARY KEY,
    organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role              TEXT NOT NULL CHECK (role IN ('owner','admin','member','read_only')),
    created_at        TIMESTAMPTZ NOT NULL,
    updated_at        TIMESTAMPTZ NOT NULL,
    UNIQUE (organization_id, user_id)
);
CREATE INDEX IF NOT EXISTS memberships_user_idx ON memberships (user_id, organization_id);

CREATE TABLE IF NOT EXISTS provider_connections (
    id                     UUID PRIMARY KEY,
    organization_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    provider               TEXT NOT NULL,
    external_account_id    TEXT NOT NULL,
    installation_ref       TEXT,
    status                 TEXT NOT NULL CHECK (status IN ('active','suspended','revoked')),
    secret_reference       TEXT,
    previous_secret_reference TEXT,
    previous_secret_valid_until TIMESTAMPTZ,
    created_at             TIMESTAMPTZ NOT NULL,
    updated_at             TIMESTAMPTZ NOT NULL,
    UNIQUE (provider, external_account_id)
);
CREATE INDEX IF NOT EXISTS provider_connections_org_idx
    ON provider_connections (organization_id, status);

CREATE TABLE IF NOT EXISTS auth_sessions (
    id               UUID PRIMARY KEY,
    user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    token_hash        CHAR(64) NOT NULL UNIQUE,
    created_at        TIMESTAMPTZ NOT NULL,
    expires_at        TIMESTAMPTZ NOT NULL,
    last_used_at      TIMESTAMPTZ,
    rotated_at        TIMESTAMPTZ,
    revoked_at        TIMESTAMPTZ,
    replaced_by       UUID REFERENCES auth_sessions(id),
    CHECK (expires_at > created_at),
    CHECK (NOT (rotated_at IS NOT NULL AND revoked_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS auth_sessions_active_hash_idx
    ON auth_sessions (token_hash) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS api_keys (
    id               UUID PRIMARY KEY,
    organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id           UUID REFERENCES users(id) ON DELETE SET NULL,
    key_prefix        TEXT NOT NULL,
    key_hash          CHAR(64) NOT NULL UNIQUE,
    name              TEXT NOT NULL,
    scopes            JSONB NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL,
    expires_at        TIMESTAMPTZ,
    last_used_at      TIMESTAMPTZ,
    revoked_at        TIMESTAMPTZ,
    CHECK (expires_at IS NULL OR expires_at > created_at)
);
CREATE INDEX IF NOT EXISTS api_keys_org_active_idx
    ON api_keys (organization_id, created_at DESC) WHERE revoked_at IS NULL;

-- One durable result per (tenant, principal, route, key). request_digest binds
-- the key to the canonical request so accidental reuse cannot return another
-- operation's response.
CREATE TABLE IF NOT EXISTS api_idempotency (
    organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    principal_id     TEXT NOT NULL,
    route_name       TEXT NOT NULL,
    idempotency_key  TEXT NOT NULL,
    request_digest   CHAR(64) NOT NULL,
    state            TEXT NOT NULL CHECK (state IN ('in_progress','completed')),
    response_status  INTEGER,
    response_body    JSONB,
    created_at       TIMESTAMPTZ NOT NULL,
    completed_at     TIMESTAMPTZ,
    PRIMARY KEY (organization_id, principal_id, route_name, idempotency_key),
    CHECK ((state = 'completed') = (completed_at IS NOT NULL)),
    CHECK (state <> 'completed' OR response_status IS NOT NULL)
);

-- Fixed-window accounting in Postgres gives all API replicas one authority.
-- The application never trusts a per-process counter for production limits.
CREATE TABLE IF NOT EXISTS api_rate_windows (
    organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    principal_id     TEXT NOT NULL,
    window_start     TIMESTAMPTZ NOT NULL,
    request_count    INTEGER NOT NULL CHECK (request_count > 0),
    PRIMARY KEY (organization_id, principal_id, window_start)
);

-- Later phases populate these product rows. Defining the tenant-scoped read
-- model here lets the frozen API routes be real without fabricating fixtures.
CREATE TABLE IF NOT EXISTS review_summaries (
    review_run_id     UUID PRIMARY KEY REFERENCES review_runs(id) ON DELETE CASCADE,
    organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    payload           JSONB NOT NULL,
    generated_at      TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS review_summaries_org_idx ON review_summaries (organization_id, review_run_id);

CREATE TABLE IF NOT EXISTS review_conversations (
    id               UUID PRIMARY KEY,
    organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    repository_id    UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    pull_request_id  UUID REFERENCES pull_requests(id) ON DELETE SET NULL,
    finding_id       UUID REFERENCES review_findings(id) ON DELETE SET NULL,
    state            TEXT NOT NULL CHECK (state IN ('open','resolved','archived')),
    created_at       TIMESTAMPTZ NOT NULL,
    updated_at       TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS review_conversations_repo_idx
    ON review_conversations (organization_id, repository_id, updated_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS conversation_messages (
    id               UUID PRIMARY KEY,
    organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    conversation_id  UUID NOT NULL REFERENCES review_conversations(id) ON DELETE CASCADE,
    body              TEXT NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS conversation_messages_conversation_idx
    ON conversation_messages (organization_id, conversation_id, created_at, id);

CREATE TABLE IF NOT EXISTS knowledge_items (
    id               UUID PRIMARY KEY,
    organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    repository_id    UUID REFERENCES repositories(id) ON DELETE CASCADE,
    scope            TEXT NOT NULL CHECK (scope IN ('organization','repository','path')),
    source_type      TEXT NOT NULL,
    path             TEXT,
    summary          TEXT NOT NULL,
    authored         BOOLEAN NOT NULL DEFAULT FALSE,
    active           BOOLEAN NOT NULL DEFAULT TRUE,
    recorded_at      TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL,
    updated_at       TIMESTAMPTZ NOT NULL,
    CHECK ((scope = 'organization') = (repository_id IS NULL)),
    CHECK ((scope = 'path') = (path IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS knowledge_items_org_idx
    ON knowledge_items (organization_id, updated_at DESC, id DESC);
