-- Phase 3 checkpoint 2: auth credential hardening.
--
-- API keys can be organization-owned or user-bound. The issuance role is a
-- permanent ceiling on an API key's authority; user-bound keys are additionally
-- constrained by the user's current membership at authentication time.
ALTER TABLE api_keys
    ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'read_only'
      CHECK (role IN ('owner','admin','member','read_only'));
