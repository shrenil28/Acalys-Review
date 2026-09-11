-- Phase 4 checkpoint 4.6: durable analytics team dimension.
-- Teams here are dashboard/reporting labels attached to a membership. They do
-- not grant authorization and therefore remain independent of membership role.
ALTER TABLE memberships
    ADD COLUMN IF NOT EXISTS analytics_team TEXT;
ALTER TABLE memberships
    DROP CONSTRAINT IF EXISTS memberships_analytics_team_shape;
ALTER TABLE memberships
    ADD CONSTRAINT memberships_analytics_team_shape
    CHECK (analytics_team IS NULL OR (length(btrim(analytics_team)) BETWEEN 1 AND 100));
CREATE INDEX IF NOT EXISTS memberships_analytics_team_idx
    ON memberships (organization_id, analytics_team)
    WHERE analytics_team IS NOT NULL;
