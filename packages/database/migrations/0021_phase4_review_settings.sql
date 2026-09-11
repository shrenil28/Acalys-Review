-- Phase 4 / Checkpoint 4.6: durable organization/repository review policy.
--
-- Policy is dashboard-owned configuration. A ReviewRequest snapshots the
-- effective policy at admission so queued/replayed work never observes a later
-- settings edit.

CREATE TABLE dashboard_organization_review_settings (
    organization_id UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
    revision        BIGINT      NOT NULL CHECK (revision >= 1),
    config          JSONB       NOT NULL,
    updated_by      UUID        NOT NULL REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL,
    updated_at      TIMESTAMPTZ NOT NULL
);

CREATE TABLE dashboard_repository_review_settings (
    repository_id   UUID PRIMARY KEY REFERENCES repositories(id) ON DELETE CASCADE,
    organization_id UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    revision        BIGINT      NOT NULL CHECK (revision >= 1),
    lifecycle       TEXT        NOT NULL CHECK (lifecycle IN ('enabled','paused','archived')),
    inherit         BOOLEAN     NOT NULL,
    instructions    TEXT        NOT NULL,
    ignore_paths    JSONB       NOT NULL,
    updated_by      UUID        NOT NULL REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL,
    updated_at      TIMESTAMPTZ NOT NULL,
    UNIQUE (organization_id, repository_id)
);
CREATE INDEX dashboard_repository_review_settings_org_idx
    ON dashboard_repository_review_settings (organization_id, repository_id);

CREATE TABLE dashboard_review_settings_audit (
    id               UUID PRIMARY KEY,
    organization_id  UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    repository_id    UUID        REFERENCES repositories(id) ON DELETE CASCADE,
    actor_user_id    UUID        NOT NULL REFERENCES users(id),
    revision         BIGINT      NOT NULL CHECK (revision >= 1),
    action           TEXT        NOT NULL CHECK (action IN ('organization_update','repository_update','repository_lifecycle')),
    snapshot         JSONB       NOT NULL,
    recorded_at      TIMESTAMPTZ NOT NULL
);
CREATE INDEX dashboard_review_settings_audit_org_idx
    ON dashboard_review_settings_audit (organization_id, recorded_at DESC);

ALTER TABLE review_requests
    ADD COLUMN policy_snapshot JSONB,
    ADD COLUMN policy_fingerprint TEXT,
    ADD CONSTRAINT review_requests_policy_pair_ck CHECK (
      (policy_snapshot IS NULL AND policy_fingerprint IS NULL)
      OR
      (policy_snapshot IS NOT NULL AND policy_fingerprint ~ '^[a-f0-9]{64}$')
    );

CREATE OR REPLACE FUNCTION reject_review_request_policy_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.policy_snapshot IS DISTINCT FROM OLD.policy_snapshot
     OR NEW.policy_fingerprint IS DISTINCT FROM OLD.policy_fingerprint THEN
    RAISE EXCEPTION 'ReviewRequest policy snapshot/fingerprint are immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER review_requests_policy_immutable
BEFORE UPDATE OF policy_snapshot, policy_fingerprint ON review_requests
FOR EACH ROW EXECUTE FUNCTION reject_review_request_policy_mutation();

COMMENT ON COLUMN review_requests.policy_snapshot IS
  'Immutable effective dashboard review policy admitted with this request; NULL only for legacy pre-0021 rows.';
COMMENT ON COLUMN review_requests.policy_fingerprint IS
  'SHA-256 of canonical policy_snapshot; immutable with the snapshot.';
