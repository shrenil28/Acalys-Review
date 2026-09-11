-- Phase 4 / Checkpoint 4.6 — personal notification preferences.
--
-- Preferences belong to a membership, not the organization-wide review policy.
-- A user can therefore choose different delivery preferences in different
-- organizations without introducing another organization-policy authority.

CREATE TABLE IF NOT EXISTS dashboard_notification_preferences (
    membership_id      UUID PRIMARY KEY REFERENCES memberships(id) ON DELETE CASCADE,
    revision           BIGINT NOT NULL DEFAULT 1 CHECK (revision >= 1),
    review_complete    BOOLEAN NOT NULL DEFAULT true,
    critical_finding   BOOLEAN NOT NULL DEFAULT true,
    weekly_digest      BOOLEAN NOT NULL DEFAULT false,
    product_updates    BOOLEAN NOT NULL DEFAULT false,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
