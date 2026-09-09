import type {
  ConversationDto,
  FindingDto,
  KnowledgeItemDto,
  PreMergeCheckDto,
  PullRequestSummaryDto,
  RepositoryDto,
  ReviewRunDto,
  ReviewSummaryDto,
} from "@acalys/contracts/api/v1";
import type { PgClient, PgPool } from "./webhook/postgres-inbox.js";

export interface ApiTenantScope {
  readonly organizationId: string;
}

export interface ApiPage<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string | undefined;
}

export interface FindingFilters {
  readonly severity?: string | undefined;
  readonly category?: string | undefined;
  readonly state?: string | undefined;
}

export type IdempotencyAcquire =
  | { readonly kind: "acquired" }
  | { readonly kind: "in_progress" }
  | { readonly kind: "conflict" }
  | { readonly kind: "replay"; readonly status: number; readonly body: unknown };

function iso(value: Date): string {
  return value.toISOString();
}

function page<T extends { readonly id: string }>(rows: readonly T[], limit: number): ApiPage<T> {
  const more = rows.length > limit;
  const items = more ? rows.slice(0, limit) : rows;
  const last = items.at(-1);
  return {
    items,
    ...(more && last !== undefined ? { nextCursor: last.id } : {}),
  };
}

function authorLabel(value: unknown): string {
  if (typeof value !== "object" || value === null) return "unknown";
  const row = value as Record<string, unknown>;
  if (typeof row["displayName"] === "string") return row["displayName"];
  const provider = row["provider"];
  if (typeof provider === "object" && provider !== null) {
    const handle = (provider as Record<string, unknown>)["handle"];
    if (typeof handle === "string") return handle;
  }
  if (typeof row["integrationId"] === "string") return row["integrationId"];
  if (typeof row["agentType"] === "string") return `acalys.${row["agentType"]}`;
  if (typeof row["component"] === "string") return row["component"];
  return "unknown";
}

export class ApiStore {
  public constructor(private readonly pool: PgPool) {}

  public async listRepositories(scope: ApiTenantScope, limit: number, cursor?: string): Promise<ApiPage<RepositoryDto>> {
    const result = await this.pool.query<{
      id: string; owner: string; name: string; provider: RepositoryDto["provider"];
      visibility: RepositoryDto["visibility"]; default_branch: string | null;
      lifecycle: string; updated_at: Date;
    }>(
      `SELECT id, owner, name, provider, visibility, default_branch, lifecycle, updated_at
         FROM repositories
        WHERE organization_id = $1 AND ($2::uuid IS NULL OR id > $2::uuid)
        ORDER BY id ASC LIMIT $3`,
      [scope.organizationId, cursor ?? null, limit + 1],
    );
    return page(result.rows.map((row) => ({
      id: row.id,
      name: `${row.owner}/${row.name}`,
      provider: row.provider,
      visibility: row.visibility,
      ...(row.default_branch === null || row.default_branch === "" ? {} : { defaultBranch: row.default_branch }),
      reviewsEnabled: row.lifecycle === "active",
      updatedAt: iso(row.updated_at),
    })), limit);
  }

  public async getRepository(scope: ApiTenantScope, id: string): Promise<RepositoryDto | undefined> {
    const result = await this.pool.query<{
      id: string; owner: string; name: string; provider: RepositoryDto["provider"];
      visibility: RepositoryDto["visibility"]; default_branch: string | null;
      lifecycle: string; updated_at: Date;
    }>(
      `SELECT id, owner, name, provider, visibility, default_branch, lifecycle, updated_at
         FROM repositories WHERE organization_id = $1 AND id = $2`,
      [scope.organizationId, id],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : {
      id: row.id,
      name: `${row.owner}/${row.name}`,
      provider: row.provider,
      visibility: row.visibility,
      ...(row.default_branch === null || row.default_branch === "" ? {} : { defaultBranch: row.default_branch }),
      reviewsEnabled: row.lifecycle === "active",
      updatedAt: iso(row.updated_at),
    };
  }

  public async listPullRequests(scope: ApiTenantScope, repositoryId: string, limit: number, cursor?: string): Promise<ApiPage<PullRequestSummaryDto> | undefined> {
    const repository = await this.getRepository(scope, repositoryId);
    if (repository === undefined) return undefined;
    const result = await this.pool.query<{
      id: string; repository_id: string; number: number; title: string; author: unknown;
      state: PullRequestSummaryDto["state"]; draft: boolean; labels: unknown;
      created_at: Date; updated_at: Date;
    }>(
      `SELECT id, repository_id, number, title, author, state, draft, labels, created_at, updated_at
         FROM pull_requests
        WHERE organization_id = $1 AND repository_id = $2
          AND ($3::uuid IS NULL OR id > $3::uuid)
        ORDER BY id ASC LIMIT $4`,
      [scope.organizationId, repositoryId, cursor ?? null, limit + 1],
    );
    return page(result.rows.map((row) => ({
      id: row.id,
      repositoryId: row.repository_id,
      number: row.number,
      title: row.title,
      authorLabel: authorLabel(row.author),
      state: row.state,
      draft: row.draft,
      labels: Array.isArray(row.labels) ? row.labels.filter((label): label is string => typeof label === "string") : [],
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    })), limit);
  }


  public async resolvePullRequestReviewSeed(scope: ApiTenantScope, repositoryId: string, pullRequestId: string): Promise<{
    readonly revisionId: string;
    readonly target: unknown;
  } | undefined> {
    const result = await this.pool.query<{
      pr_id: string; provider: string; provider_external_id: string; number: number; title: string;
      description: string | null; author: unknown; draft: boolean; revision_id: string;
      head_sha: string; head_ref: string; base_sha: string; base_ref: string; merge_base_sha: string | null;
    }>(
      `SELECT p.id AS pr_id, p.provider, p.provider_external_id, p.number, p.title, p.description,
              p.author, p.draft, v.id AS revision_id, v.head_sha, v.head_ref, v.base_sha,
              v.base_ref, v.merge_base_sha
         FROM pull_requests p
         JOIN LATERAL (
           SELECT id, head_sha, head_ref, base_sha, base_ref, merge_base_sha
             FROM pull_request_revisions
            WHERE organization_id = p.organization_id AND pull_request_id = p.id
            ORDER BY sequence DESC LIMIT 1
         ) v ON TRUE
        WHERE p.organization_id = $1 AND p.repository_id = $2 AND p.id = $3`,
      [scope.organizationId, repositoryId, pullRequestId],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    const objectId = (value: string) => ({ algorithm: value.length === 64 ? "sha256" : "sha1", value: value.toLowerCase() });
    return {
      revisionId: row.revision_id,
      target: {
        kind: "pull_request",
        schemaVersion: 1,
        repositoryId,
        provider: row.provider,
        changeRequest: { kind: "change_request", provider: row.provider, externalId: row.provider_external_id, number: row.number },
        base: { name: row.base_ref, objectId: objectId(row.base_sha) },
        head: { name: row.head_ref, objectId: objectId(row.head_sha) },
        ...(row.merge_base_sha === null ? {} : { mergeBase: { objectId: objectId(row.merge_base_sha) } }),
        title: row.title,
        ...(row.description === null ? {} : { description: row.description }),
        author: row.author,
        draft: row.draft,
      },
    };
  }

  public async getReview(scope: ApiTenantScope, id: string): Promise<ReviewRunDto | undefined> {
    const result = await this.pool.query<{
      id: string; repository_id: string; pull_request_id: string | null; state: ReviewRunDto["state"];
      failure_code: string | null; created_at: Date; started_at: Date | null; completed_at: Date | null;
    }>(
      `SELECT r.id, r.repository_id, q.pull_request_id, r.state, r.failure_code,
              r.created_at, r.started_at, r.completed_at
         FROM review_runs r
         JOIN review_requests q ON q.id = r.request_id AND q.organization_id = r.organization_id
        WHERE r.organization_id = $1 AND r.id = $2`,
      [scope.organizationId, id],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    const settled = row.state === "completed" || row.state === "failed" || row.state === "cancelled" || row.state === "superseded";
    return {
      id: row.id,
      repositoryId: row.repository_id,
      ...(row.pull_request_id === null ? {} : { pullRequestId: row.pull_request_id }),
      state: row.state,
      settled,
      ...(row.failure_code === null ? {} : { failureCode: row.failure_code }),
      createdAt: iso(row.created_at),
      ...(row.started_at === null ? {} : { startedAt: iso(row.started_at) }),
      ...(row.completed_at === null ? {} : { completedAt: iso(row.completed_at) }),
    };
  }

  public async cancelReview(scope: ApiTenantScope, id: string, now: Date): Promise<"moved" | "not_found" | "conflict"> {
    return this.inTransaction(async (client) => {
      const current = await client.query<{ state: string }>(
        `SELECT state FROM review_runs WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
        [scope.organizationId, id],
      );
      const state = current.rows[0]?.state;
      if (state === undefined) return "not_found";
      if (!["queued", "preparing", "analyzing", "reviewing", "verifying", "reconciling"].includes(state)) return "conflict";
      const seq = await client.query<{ next_seq: number }>(
        `SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM review_run_transitions WHERE run_id = $1`, [id],
      );
      await client.query(
        `UPDATE review_runs SET state = 'cancelled', completed_at = $3
          WHERE organization_id = $1 AND id = $2 AND state = $4`,
        [scope.organizationId, id, now, state],
      );
      await client.query(
        `INSERT INTO review_run_transitions (run_id, seq, from_state, to_state, at)
         VALUES ($1,$2,$3,'cancelled',$4)`,
        [id, seq.rows[0]?.next_seq ?? 1, state, now],
      );
      return "moved";
    });
  }

  public async getReviewSummary(scope: ApiTenantScope, reviewRunId: string): Promise<ReviewSummaryDto | undefined> {
    const result = await this.pool.query<{ review_run_id: string; payload: unknown }>(
      `SELECT review_run_id, payload FROM review_summaries WHERE organization_id = $1 AND review_run_id = $2`,
      [scope.organizationId, reviewRunId],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    if (typeof row.payload !== "object" || row.payload === null || Array.isArray(row.payload)) {
      return row.payload as ReviewSummaryDto;
    }
    // The relational key is the authority for resource identity. A later-phase
    // summary writer must not be able to smuggle a different tenant/run id
    // through the opaque JSON payload and have the API serialize it.
    return { ...row.payload, reviewRunId: row.review_run_id } as ReviewSummaryDto;
  }

  public async listReviewFindings(scope: ApiTenantScope, reviewRunId: string, limit: number, cursor: string | undefined, filters: FindingFilters): Promise<ApiPage<FindingDto> | undefined> {
    const review = await this.getReview(scope, reviewRunId);
    if (review === undefined) return undefined;
    const result = await this.pool.query<{
      id: string; repository_id: string; review_run_id: string; severity: FindingDto["severity"];
      category: FindingDto["category"]; confidence_level: FindingDto["confidence"];
      state: FindingDto["lifecycle"]; title: string; explanation: string; path: string;
      start_line: number; end_line: number; evidence_count: number; suggested_fix_id: string | null; created_at: Date;
    }>(
      `SELECT id, repository_id, review_run_id, severity, category, confidence_level, state,
              title, explanation, path, start_line, end_line, evidence_count,
              suggested_fix_id, created_at
         FROM review_findings
        WHERE organization_id = $1 AND review_run_id = $2
          AND ($3::text IS NULL OR severity = $3)
          AND ($4::text IS NULL OR category = $4)
          AND ($5::text IS NULL OR state = $5)
          AND ($6::uuid IS NULL OR id > $6::uuid)
        ORDER BY id ASC LIMIT $7`,
      [scope.organizationId, reviewRunId, filters.severity ?? null, filters.category ?? null,
       filters.state ?? null, cursor ?? null, limit + 1],
    );
    return page(result.rows.map((row) => ({
      id: row.id,
      repositoryId: row.repository_id,
      reviewRunId: row.review_run_id,
      severity: row.severity,
      category: row.category,
      confidence: row.confidence_level,
      lifecycle: row.state,
      title: row.title,
      explanation: row.explanation,
      path: row.path,
      startLine: row.start_line,
      endLine: row.end_line,
      evidenceCount: row.evidence_count,
      hasSuggestedFix: row.suggested_fix_id !== null,
      createdAt: iso(row.created_at),
    })), limit);
  }

  public async listReviewChecks(scope: ApiTenantScope, reviewRunId: string): Promise<ApiPage<PreMergeCheckDto> | undefined> {
    const review = await this.getReview(scope, reviewRunId);
    if (review === undefined) return undefined;
    const result = await this.pool.query<{
      id: string; review_run_id: string; check_id: string; name: string;
      status: PreMergeCheckDto["status"]; blocking: boolean; explanation: string | null; evaluated_at: Date | null;
    }>(
      `SELECT id, review_run_id, check_id, name, status, blocking, explanation, evaluated_at
         FROM premerge_check_results
        WHERE organization_id = $1 AND review_run_id = $2 ORDER BY id ASC LIMIT 101`,
      [scope.organizationId, reviewRunId],
    );
    return { items: result.rows.slice(0, 100).map((row) => ({
      id: row.id,
      reviewRunId: row.review_run_id,
      checkId: row.check_id,
      name: row.name,
      status: row.status,
      blocking: row.blocking,
      ...(row.explanation === null ? {} : { explanation: row.explanation }),
      ...(row.evaluated_at === null ? {} : { evaluatedAt: iso(row.evaluated_at) }),
    })), ...(result.rows.length > 100 ? { nextCursor: result.rows[99]?.id } : {}) };
  }

  public async getFinding(scope: ApiTenantScope, id: string): Promise<FindingDto | undefined> {
    const result = await this.pool.query<{
      id: string; repository_id: string; review_run_id: string; severity: FindingDto["severity"];
      category: FindingDto["category"]; confidence_level: FindingDto["confidence"]; state: FindingDto["lifecycle"];
      title: string; explanation: string; path: string; start_line: number; end_line: number;
      evidence_count: number; suggested_fix_id: string | null; created_at: Date;
    }>(
      `SELECT id, repository_id, review_run_id, severity, category, confidence_level, state,
              title, explanation, path, start_line, end_line, evidence_count, suggested_fix_id, created_at
         FROM review_findings WHERE organization_id = $1 AND id = $2`,
      [scope.organizationId, id],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : {
      id: row.id, repositoryId: row.repository_id, reviewRunId: row.review_run_id,
      severity: row.severity, category: row.category, confidence: row.confidence_level,
      lifecycle: row.state, title: row.title, explanation: row.explanation, path: row.path,
      startLine: row.start_line, endLine: row.end_line, evidenceCount: row.evidence_count,
      hasSuggestedFix: row.suggested_fix_id !== null, createdAt: iso(row.created_at),
    };
  }

  public async dismissFinding(scope: ApiTenantScope, id: string, now: Date): Promise<"moved" | "not_found" | "conflict"> {
    const result = await this.pool.query(
      `UPDATE review_findings SET state = 'dismissed', updated_at = $3
        WHERE organization_id = $1 AND id = $2 AND state = 'published'`,
      [scope.organizationId, id, now],
    );
    if (result.rowCount === 1) return "moved";
    const exists = await this.pool.query(`SELECT 1 FROM review_findings WHERE organization_id = $1 AND id = $2`, [scope.organizationId, id]);
    return exists.rowCount === 0 ? "not_found" : "conflict";
  }

  public async listConversations(scope: ApiTenantScope, repositoryId: string, limit: number, cursor?: string): Promise<ApiPage<ConversationDto> | undefined> {
    const repository = await this.getRepository(scope, repositoryId);
    if (repository === undefined) return undefined;
    const result = await this.pool.query<{
      id: string; repository_id: string; pull_request_id: string | null; finding_id: string | null;
      state: ConversationDto["state"]; message_count: number; created_at: Date; updated_at: Date;
    }>(
      `SELECT c.id, c.repository_id, c.pull_request_id, c.finding_id, c.state,
              COUNT(m.id)::int AS message_count, c.created_at, c.updated_at
         FROM review_conversations c
         LEFT JOIN conversation_messages m
           ON m.organization_id = c.organization_id AND m.conversation_id = c.id
        WHERE c.organization_id = $1 AND c.repository_id = $2
          AND ($3::uuid IS NULL OR c.id > $3::uuid)
        GROUP BY c.id
        ORDER BY c.id ASC LIMIT $4`,
      [scope.organizationId, repositoryId, cursor ?? null, limit + 1],
    );
    return page(result.rows.map((row) => ({
      id: row.id, repositoryId: row.repository_id,
      ...(row.pull_request_id === null ? {} : { pullRequestId: row.pull_request_id }),
      ...(row.finding_id === null ? {} : { findingId: row.finding_id }),
      state: row.state, messageCount: row.message_count,
      createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
    })), limit);
  }

  public async resolveConversation(scope: ApiTenantScope, id: string, now: Date): Promise<"moved" | "not_found" | "conflict"> {
    const result = await this.pool.query(
      `UPDATE review_conversations SET state = 'resolved', updated_at = $3
        WHERE organization_id = $1 AND id = $2 AND state = 'open'`,
      [scope.organizationId, id, now],
    );
    if (result.rowCount === 1) return "moved";
    const exists = await this.pool.query(`SELECT 1 FROM review_conversations WHERE organization_id = $1 AND id = $2`, [scope.organizationId, id]);
    return exists.rowCount === 0 ? "not_found" : "conflict";
  }

  public async getConversation(scope: ApiTenantScope, id: string): Promise<ConversationDto | undefined> {
    const result = await this.pool.query<{
      id: string; repository_id: string; pull_request_id: string | null; finding_id: string | null;
      state: ConversationDto["state"]; message_count: number; created_at: Date; updated_at: Date;
    }>(
      `SELECT c.id, c.repository_id, c.pull_request_id, c.finding_id, c.state,
              COUNT(m.id)::int AS message_count, c.created_at, c.updated_at
         FROM review_conversations c
         LEFT JOIN conversation_messages m
           ON m.organization_id = c.organization_id AND m.conversation_id = c.id
        WHERE c.organization_id = $1 AND c.id = $2 GROUP BY c.id`,
      [scope.organizationId, id],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : {
      id: row.id, repositoryId: row.repository_id,
      ...(row.pull_request_id === null ? {} : { pullRequestId: row.pull_request_id }),
      ...(row.finding_id === null ? {} : { findingId: row.finding_id }),
      state: row.state, messageCount: row.message_count,
      createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
    };
  }

  public async listKnowledge(scope: ApiTenantScope, limit: number, cursor?: string): Promise<ApiPage<KnowledgeItemDto>> {
    const result = await this.pool.query<{
      id: string; source_type: KnowledgeItemDto["sourceType"]; scope: KnowledgeItemDto["scope"];
      repository_id: string | null; path: string | null; summary: string; authored: boolean; recorded_at: Date | null;
    }>(
      `SELECT id, source_type, scope, repository_id, path, summary, authored, recorded_at
         FROM knowledge_items
        WHERE organization_id = $1 AND active = TRUE AND ($2::uuid IS NULL OR id > $2::uuid)
        ORDER BY id ASC LIMIT $3`,
      [scope.organizationId, cursor ?? null, limit + 1],
    );
    return page(result.rows.map((row) => ({
      id: row.id, sourceType: row.source_type, scope: row.scope,
      ...(row.repository_id === null ? {} : { repositoryId: row.repository_id }),
      ...(row.path === null ? {} : { path: row.path }),
      summary: row.summary, authored: row.authored,
      ...(row.recorded_at === null ? {} : { recordedAt: iso(row.recorded_at) }),
    })), limit);
  }

  public async reviewEvents(scope: ApiTenantScope, reviewRunId: string, afterSeq: number, limit = 100): Promise<readonly { readonly id: number; readonly event: string; readonly data: unknown }[] | undefined> {
    const review = await this.getReview(scope, reviewRunId);
    if (review === undefined) return undefined;
    const result = await this.pool.query<{ seq: number; from_state: string; to_state: string; at: Date }>(
      `SELECT t.seq, t.from_state, t.to_state, t.at
         FROM review_run_transitions t
         JOIN review_runs r ON r.id = t.run_id
        WHERE r.organization_id = $1 AND t.run_id = $2 AND t.seq > $3
        ORDER BY t.seq ASC LIMIT $4`,
      [scope.organizationId, reviewRunId, afterSeq, limit],
    );
    return result.rows.map((row) => ({
      id: row.seq,
      event: "review.state_changed",
      data: { reviewRunId, from: row.from_state, to: row.to_state, at: iso(row.at) },
    }));
  }

  public async acquireIdempotency(input: {
    readonly scope: ApiTenantScope; readonly principalId: string; readonly routeName: string;
    readonly key: string; readonly requestDigest: string; readonly now: Date;
  }): Promise<IdempotencyAcquire> {
    return this.inTransaction(async (client) => {
      const existing = await client.query<{ request_digest: string; state: string; response_status: number | null; response_body: unknown }>(
        `SELECT request_digest, state, response_status, response_body
           FROM api_idempotency
          WHERE organization_id = $1 AND principal_id = $2 AND route_name = $3 AND idempotency_key = $4
          FOR UPDATE`,
        [input.scope.organizationId, input.principalId, input.routeName, input.key],
      );
      const row = existing.rows[0];
      if (row !== undefined) {
        if (row.request_digest !== input.requestDigest) return { kind: "conflict" };
        if (row.state === "completed" && row.response_status !== null) return { kind: "replay", status: row.response_status, body: row.response_body };
        return { kind: "in_progress" };
      }
      await client.query(
        `INSERT INTO api_idempotency
           (organization_id, principal_id, route_name, idempotency_key, request_digest, state, created_at)
         VALUES ($1,$2,$3,$4,$5,'in_progress',$6)`,
        [input.scope.organizationId, input.principalId, input.routeName, input.key, input.requestDigest, input.now],
      );
      return { kind: "acquired" };
    });
  }

  public async completeIdempotency(input: {
    readonly scope: ApiTenantScope; readonly principalId: string; readonly routeName: string;
    readonly key: string; readonly requestDigest: string; readonly status: number; readonly body: unknown; readonly now: Date;
  }): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE api_idempotency
          SET state = 'completed', response_status = $6, response_body = $7::jsonb, completed_at = $8
        WHERE organization_id = $1 AND principal_id = $2 AND route_name = $3
          AND idempotency_key = $4 AND request_digest = $5 AND state = 'in_progress'`,
      [input.scope.organizationId, input.principalId, input.routeName, input.key, input.requestDigest,
       input.status, JSON.stringify(input.body), input.now],
    );
    return result.rowCount === 1;
  }

  public async abandonIdempotency(input: {
    readonly scope: ApiTenantScope; readonly principalId: string; readonly routeName: string;
    readonly key: string; readonly requestDigest: string;
  }): Promise<void> {
    await this.pool.query(
      `DELETE FROM api_idempotency
        WHERE organization_id = $1 AND principal_id = $2 AND route_name = $3
          AND idempotency_key = $4 AND request_digest = $5 AND state = 'in_progress'`,
      [input.scope.organizationId, input.principalId, input.routeName, input.key, input.requestDigest],
    );
  }

  private async inTransaction<T>(work: (client: PgClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const value = await work(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
