-- Phase 4 checkpoint 4.6: explicit membership invitation capabilities.
--
-- Invitation secrets are bearer capabilities. Persist only their SHA-256 digest;
-- the raw `acalys_invite_...` value is returned exactly once by the dashboard API.
-- Redemption is database-clock authoritative and is coupled transactionally to
-- membership creation plus the one-time login exchange used by the browser.

CREATE TABLE IF NOT EXISTS dashboard_membership_invitations (
    id               UUID PRIMARY KEY,
    organization_id  UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    email            TEXT        NOT NULL,
    role             TEXT        NOT NULL CHECK (role IN ('owner','admin','member','read_only')),
    invite_hash      CHAR(64)    NOT NULL UNIQUE,
    created_by       UUID        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at       TIMESTAMPTZ NOT NULL,
    expires_at       TIMESTAMPTZ NOT NULL,
    cancelled_at     TIMESTAMPTZ,
    redeemed_at      TIMESTAMPTZ,
    CHECK (length(btrim(email)) > 0),
    CHECK (expires_at > created_at),
    CHECK (cancelled_at IS NULL OR cancelled_at >= created_at),
    CHECK (redeemed_at IS NULL OR redeemed_at >= created_at),
    CHECK (NOT (cancelled_at IS NOT NULL AND redeemed_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS dashboard_membership_invitations_org_live_idx
    ON dashboard_membership_invitations (organization_id, expires_at, id)
    WHERE cancelled_at IS NULL AND redeemed_at IS NULL;

CREATE INDEX IF NOT EXISTS dashboard_membership_invitations_email_live_idx
    ON dashboard_membership_invitations (organization_id, lower(email), expires_at)
    WHERE cancelled_at IS NULL AND redeemed_at IS NULL;
