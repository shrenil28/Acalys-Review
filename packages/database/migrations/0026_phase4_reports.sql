-- Phase 4 / Checkpoint 4.6 — durable report definitions and generated evidence snapshots.
-- Scheduling/delivery workers are deliberately not implied by this schema. A recurring
-- definition is configuration only until a dispatcher is introduced; report runs record
-- only snapshots that were actually generated.

CREATE TABLE IF NOT EXISTS dashboard_reports (
    id                    UUID PRIMARY KEY,
    organization_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    created_by_membership_id UUID NOT NULL REFERENCES memberships(id) ON DELETE RESTRICT,
    kind                  TEXT NOT NULL CHECK (kind IN ('recurring','ondemand')),
    name                  TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
    revision              BIGINT NOT NULL DEFAULT 1 CHECK (revision >= 1),
    enabled               BOOLEAN NOT NULL DEFAULT true,
    schedule              JSONB,
    range_config          JSONB NOT NULL,
    parameters            JSONB NOT NULL DEFAULT '{"repositoryIds":[],"usernames":[],"teams":[]}'::jsonb,
    prompt                TEXT NOT NULL DEFAULT '' CHECK (length(prompt) <= 10000),
    group_by              TEXT NOT NULL DEFAULT 'none' CHECK (group_by IN ('none','repository','team','author','severity')),
    destination           JSONB NOT NULL,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CHECK ((kind='recurring' AND schedule IS NOT NULL) OR (kind='ondemand' AND schedule IS NULL))
);
CREATE INDEX IF NOT EXISTS dashboard_reports_org_updated_idx
    ON dashboard_reports (organization_id, updated_at DESC, id);

CREATE TABLE IF NOT EXISTS dashboard_report_runs (
    id                UUID PRIMARY KEY,
    organization_id   UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    report_id          UUID NOT NULL REFERENCES dashboard_reports(id) ON DELETE CASCADE,
    report_revision    BIGINT NOT NULL CHECK (report_revision >= 1),
    range_from         TIMESTAMPTZ NOT NULL,
    range_to           TIMESTAMPTZ NOT NULL,
    snapshot           JSONB NOT NULL,
    generated_at       TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CHECK (range_to > range_from)
);
CREATE INDEX IF NOT EXISTS dashboard_report_runs_report_generated_idx
    ON dashboard_report_runs (organization_id, report_id, generated_at DESC, id);
