-- Phase 3 checkpoint 7: durable credential ownership and membership fencing.
--
-- Joining credentials to whatever membership happens to exist for (org,user)
-- is not enough: deleting and later recreating that membership would revive an
-- unexpired session/API key. API keys have an additional hazard because their
-- user_id FK uses ON DELETE SET NULL, which can otherwise make a former user
-- key indistinguishable from an organization-owned key after user deletion.
--
-- Persist the exact membership that authorized issuance and an immutable owner
-- kind. Membership deletion nulls only the membership referent, leaving the
-- credential row as an auditable, permanently unusable tombstone. Re-adding a
-- membership creates a different id and cannot resurrect the credential.

ALTER TABLE auth_sessions
    ADD COLUMN IF NOT EXISTS membership_id UUID;

UPDATE auth_sessions AS s
   SET membership_id = m.id
  FROM memberships AS m
 WHERE s.membership_id IS NULL
   AND m.organization_id = s.organization_id
   AND m.user_id = s.user_id;

-- A session that cannot be attributed to a live membership is permanently
-- revoked during upgrade. Later membership recreation must not revive it.
UPDATE auth_sessions
   SET revoked_at = COALESCE(revoked_at, clock_timestamp())
 WHERE membership_id IS NULL
   AND rotated_at IS NULL;

ALTER TABLE auth_sessions
    DROP CONSTRAINT IF EXISTS auth_sessions_membership_id_fkey;
ALTER TABLE auth_sessions
    ADD CONSTRAINT auth_sessions_membership_id_fkey
    FOREIGN KEY (membership_id) REFERENCES memberships(id) ON DELETE SET NULL
    NOT VALID;
ALTER TABLE auth_sessions VALIDATE CONSTRAINT auth_sessions_membership_id_fkey;
CREATE INDEX IF NOT EXISTS auth_sessions_membership_idx
    ON auth_sessions (membership_id) WHERE membership_id IS NOT NULL;

ALTER TABLE api_keys
    ADD COLUMN IF NOT EXISTS owner_kind TEXT;

UPDATE api_keys
   SET owner_kind = CASE WHEN user_id IS NULL THEN 'legacy_unbound' ELSE 'user' END
 WHERE owner_kind IS NULL;

ALTER TABLE api_keys
    ALTER COLUMN owner_kind SET NOT NULL;
ALTER TABLE api_keys
    DROP CONSTRAINT IF EXISTS api_keys_owner_kind_check;
ALTER TABLE api_keys
    ADD CONSTRAINT api_keys_owner_kind_check
    CHECK (owner_kind IN ('organization','user','legacy_unbound'));

ALTER TABLE api_keys
    ADD COLUMN IF NOT EXISTS membership_id UUID;

UPDATE api_keys AS k
   SET membership_id = m.id
  FROM memberships AS m
 WHERE k.owner_kind = 'user'
   AND k.user_id IS NOT NULL
   AND k.membership_id IS NULL
   AND m.organization_id = k.organization_id
   AND m.user_id = k.user_id;

-- Ambiguous legacy NULL-user keys and orphaned user keys fail closed at the
-- data layer as well as in AuthStore. Explicit organization keys must be
-- reissued after this migration because old rows did not carry enough
-- provenance to distinguish them from a deleted user's key safely.
UPDATE api_keys
   SET revoked_at = COALESCE(revoked_at, clock_timestamp())
 WHERE owner_kind = 'legacy_unbound'
    OR (owner_kind = 'user' AND membership_id IS NULL);

ALTER TABLE api_keys
    DROP CONSTRAINT IF EXISTS api_keys_membership_id_fkey;
ALTER TABLE api_keys
    ADD CONSTRAINT api_keys_membership_id_fkey
    FOREIGN KEY (membership_id) REFERENCES memberships(id) ON DELETE SET NULL
    NOT VALID;
ALTER TABLE api_keys VALIDATE CONSTRAINT api_keys_membership_id_fkey;
CREATE INDEX IF NOT EXISTS api_keys_membership_idx
    ON api_keys (membership_id) WHERE membership_id IS NOT NULL;

-- Existing NULL-user keys are deliberately marked legacy_unbound rather than
-- guessed to be organization-owned: before this column existed, a deleted
-- user's key and a true organization key were indistinguishable. Failing those
-- ambiguous credentials closed is safer than silently promoting one. New
-- organization keys are explicitly stamped by AuthStore and remain usable.
-- User-owned tombstones may have their user/membership referents nulled by FK
-- deletion; owner_kind keeps them distinguishable from organization keys.
ALTER TABLE api_keys
    DROP CONSTRAINT IF EXISTS api_keys_owner_shape_check;
ALTER TABLE api_keys
    ADD CONSTRAINT api_keys_owner_shape_check
    CHECK (
      owner_kind <> 'organization'
      OR (user_id IS NULL AND membership_id IS NULL)
    );
