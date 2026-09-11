-- Phase 4 dashboard/browser administration bridge.
--
-- OAuth callbacks never put a durable session credential in a redirect URL or
-- persist recoverable session material. The callback stores only a one-way
-- hash of a high-entropy, short-lived exchange handle plus the exact membership
-- provenance that authorized the login. Redemption is database-clock
-- authoritative and atomic; the real session is issued only after redemption.

CREATE TABLE dashboard_login_exchanges (
    id                  UUID PRIMARY KEY,
    organization_id     UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id             UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    membership_id       UUID        REFERENCES memberships(id) ON DELETE SET NULL,
    exchange_hash       CHAR(64)    NOT NULL UNIQUE,
    created_at          TIMESTAMPTZ NOT NULL,
    expires_at          TIMESTAMPTZ NOT NULL,
    redeemed_at         TIMESTAMPTZ,
    CHECK (expires_at > created_at),
    CHECK (redeemed_at IS NULL OR redeemed_at >= created_at)
);

CREATE INDEX dashboard_login_exchanges_live_idx
    ON dashboard_login_exchanges (expires_at)
    WHERE redeemed_at IS NULL;
