-- Phase 3 checkpoint 4: make the denormalized tenant key part of every
-- API-reachable parent/child relationship.
--
-- Filtering queries by organization_id is necessary but not sufficient. With
-- only single-column foreign keys a malformed internal write could create, for
-- example, an organization-A finding that points at an organization-B review
-- run. The A-scoped API query would then be allowed to serialize identifiers
-- from B. Composite foreign keys make that state unrepresentable.
--
-- The extra unique indexes are the referenced keys for the composite FKs. `id`
-- remains the logical primary key; these indexes exist only to bind it to the
-- tenant at the relational boundary.

CREATE UNIQUE INDEX IF NOT EXISTS repositories_organization_id_id_uq
    ON repositories (organization_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS pull_requests_organization_id_id_uq
    ON pull_requests (organization_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS pull_request_revisions_organization_id_id_uq
    ON pull_request_revisions (organization_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS review_requests_organization_id_id_uq
    ON review_requests (organization_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS review_runs_organization_id_id_uq
    ON review_runs (organization_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS review_findings_organization_id_id_uq
    ON review_findings (organization_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS review_conversations_organization_id_id_uq
    ON review_conversations (organization_id, id);

ALTER TABLE pull_requests
    ADD CONSTRAINT pull_requests_repository_tenant_fk
    FOREIGN KEY (organization_id, repository_id)
    REFERENCES repositories (organization_id, id)
    NOT VALID;

ALTER TABLE pull_request_revisions
    ADD CONSTRAINT pull_request_revisions_repository_tenant_fk
    FOREIGN KEY (organization_id, repository_id)
    REFERENCES repositories (organization_id, id)
    NOT VALID,
    ADD CONSTRAINT pull_request_revisions_pull_request_tenant_fk
    FOREIGN KEY (organization_id, pull_request_id)
    REFERENCES pull_requests (organization_id, id)
    NOT VALID;

ALTER TABLE review_requests
    ADD CONSTRAINT review_requests_repository_tenant_fk
    FOREIGN KEY (organization_id, repository_id)
    REFERENCES repositories (organization_id, id)
    NOT VALID,
    ADD CONSTRAINT review_requests_pull_request_tenant_fk
    FOREIGN KEY (organization_id, pull_request_id)
    REFERENCES pull_requests (organization_id, id)
    NOT VALID,
    ADD CONSTRAINT review_requests_revision_tenant_fk
    FOREIGN KEY (organization_id, revision_id)
    REFERENCES pull_request_revisions (organization_id, id)
    NOT VALID;

ALTER TABLE review_runs
    ADD CONSTRAINT review_runs_repository_tenant_fk
    FOREIGN KEY (organization_id, repository_id)
    REFERENCES repositories (organization_id, id)
    NOT VALID,
    ADD CONSTRAINT review_runs_request_tenant_fk
    FOREIGN KEY (organization_id, request_id)
    REFERENCES review_requests (organization_id, id)
    NOT VALID,
    ADD CONSTRAINT review_runs_revision_tenant_fk
    FOREIGN KEY (organization_id, revision_id)
    REFERENCES pull_request_revisions (organization_id, id)
    NOT VALID;

ALTER TABLE review_findings
    ADD CONSTRAINT review_findings_repository_tenant_fk
    FOREIGN KEY (organization_id, repository_id)
    REFERENCES repositories (organization_id, id)
    NOT VALID,
    ADD CONSTRAINT review_findings_run_tenant_fk
    FOREIGN KEY (organization_id, review_run_id)
    REFERENCES review_runs (organization_id, id)
    ON DELETE CASCADE
    NOT VALID,
    ADD CONSTRAINT review_findings_revision_tenant_fk
    FOREIGN KEY (organization_id, revision_id)
    REFERENCES pull_request_revisions (organization_id, id)
    NOT VALID;

ALTER TABLE premerge_check_results
    ADD CONSTRAINT premerge_check_results_repository_tenant_fk
    FOREIGN KEY (organization_id, repository_id)
    REFERENCES repositories (organization_id, id)
    NOT VALID,
    ADD CONSTRAINT premerge_check_results_run_tenant_fk
    FOREIGN KEY (organization_id, review_run_id)
    REFERENCES review_runs (organization_id, id)
    ON DELETE CASCADE
    NOT VALID;

ALTER TABLE review_summaries
    ADD CONSTRAINT review_summaries_run_tenant_fk
    FOREIGN KEY (organization_id, review_run_id)
    REFERENCES review_runs (organization_id, id)
    ON DELETE CASCADE
    NOT VALID;

ALTER TABLE review_conversations
    ADD CONSTRAINT review_conversations_repository_tenant_fk
    FOREIGN KEY (organization_id, repository_id)
    REFERENCES repositories (organization_id, id)
    ON DELETE CASCADE
    NOT VALID,
    ADD CONSTRAINT review_conversations_pull_request_tenant_fk
    FOREIGN KEY (organization_id, pull_request_id)
    REFERENCES pull_requests (organization_id, id)
    ON DELETE SET NULL (pull_request_id)
    NOT VALID,
    ADD CONSTRAINT review_conversations_finding_tenant_fk
    FOREIGN KEY (organization_id, finding_id)
    REFERENCES review_findings (organization_id, id)
    ON DELETE SET NULL (finding_id)
    NOT VALID;

ALTER TABLE conversation_messages
    ADD CONSTRAINT conversation_messages_conversation_tenant_fk
    FOREIGN KEY (organization_id, conversation_id)
    REFERENCES review_conversations (organization_id, id)
    ON DELETE CASCADE
    NOT VALID;

ALTER TABLE knowledge_items
    ADD CONSTRAINT knowledge_items_repository_tenant_fk
    FOREIGN KEY (organization_id, repository_id)
    REFERENCES repositories (organization_id, id)
    ON DELETE CASCADE
    NOT VALID;

ALTER TABLE review_dispatch_jobs
    ADD CONSTRAINT review_dispatch_jobs_run_tenant_fk
    FOREIGN KEY (organization_id, review_run_id)
    REFERENCES review_runs (organization_id, id)
    ON DELETE CASCADE
    NOT VALID,
    ADD CONSTRAINT review_dispatch_jobs_revision_tenant_fk
    FOREIGN KEY (organization_id, revision_id)
    REFERENCES pull_request_revisions (organization_id, id)
    ON DELETE CASCADE
    NOT VALID,
    ADD CONSTRAINT review_dispatch_jobs_pull_request_tenant_fk
    FOREIGN KEY (organization_id, pull_request_id)
    REFERENCES pull_requests (organization_id, id)
    ON DELETE CASCADE
    NOT VALID;

-- NOT VALID reduces the lock level while constraints are installed. Validation
-- is still mandatory in this migration: pre-existing cross-tenant rows abort
-- the migration rather than being grandfathered into the production schema.
ALTER TABLE pull_requests VALIDATE CONSTRAINT pull_requests_repository_tenant_fk;
ALTER TABLE pull_request_revisions VALIDATE CONSTRAINT pull_request_revisions_repository_tenant_fk;
ALTER TABLE pull_request_revisions VALIDATE CONSTRAINT pull_request_revisions_pull_request_tenant_fk;
ALTER TABLE review_requests VALIDATE CONSTRAINT review_requests_repository_tenant_fk;
ALTER TABLE review_requests VALIDATE CONSTRAINT review_requests_pull_request_tenant_fk;
ALTER TABLE review_requests VALIDATE CONSTRAINT review_requests_revision_tenant_fk;
ALTER TABLE review_runs VALIDATE CONSTRAINT review_runs_repository_tenant_fk;
ALTER TABLE review_runs VALIDATE CONSTRAINT review_runs_request_tenant_fk;
ALTER TABLE review_runs VALIDATE CONSTRAINT review_runs_revision_tenant_fk;
ALTER TABLE review_findings VALIDATE CONSTRAINT review_findings_repository_tenant_fk;
ALTER TABLE review_findings VALIDATE CONSTRAINT review_findings_run_tenant_fk;
ALTER TABLE review_findings VALIDATE CONSTRAINT review_findings_revision_tenant_fk;
ALTER TABLE premerge_check_results VALIDATE CONSTRAINT premerge_check_results_repository_tenant_fk;
ALTER TABLE premerge_check_results VALIDATE CONSTRAINT premerge_check_results_run_tenant_fk;
ALTER TABLE review_summaries VALIDATE CONSTRAINT review_summaries_run_tenant_fk;
ALTER TABLE review_conversations VALIDATE CONSTRAINT review_conversations_repository_tenant_fk;
ALTER TABLE review_conversations VALIDATE CONSTRAINT review_conversations_pull_request_tenant_fk;
ALTER TABLE review_conversations VALIDATE CONSTRAINT review_conversations_finding_tenant_fk;
ALTER TABLE conversation_messages VALIDATE CONSTRAINT conversation_messages_conversation_tenant_fk;
ALTER TABLE knowledge_items VALIDATE CONSTRAINT knowledge_items_repository_tenant_fk;
ALTER TABLE review_dispatch_jobs VALIDATE CONSTRAINT review_dispatch_jobs_run_tenant_fk;
ALTER TABLE review_dispatch_jobs VALIDATE CONSTRAINT review_dispatch_jobs_revision_tenant_fk;
ALTER TABLE review_dispatch_jobs VALIDATE CONSTRAINT review_dispatch_jobs_pull_request_tenant_fk;
