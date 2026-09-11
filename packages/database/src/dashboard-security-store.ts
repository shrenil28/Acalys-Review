import type { FindingLifecycleState, FindingSeverity } from "@acalys/contracts/domain";
import type { PgClient, PgPool } from "./webhook/postgres-inbox.js";

export interface DashboardSecurityFilters {
  readonly organizationId: string;
  readonly repositoryIds: readonly string[];
  readonly severities: readonly FindingSeverity[];
  readonly lifecycle: readonly FindingLifecycleState[];
  readonly limit: number;
}

export interface DashboardSecurityFindingRow {
  readonly id: string;
  readonly repositoryId: string;
  readonly repositoryName: string;
  readonly reviewRunId: string;
  readonly pullRequestId: string | null;
  readonly pullRequestNumber: number | null;
  readonly pullRequestTitle: string | null;
  readonly author: string | null;
  readonly pullRequestState: "open" | "closed" | "merged" | null;
  readonly severity: FindingSeverity;
  readonly lifecycle: FindingLifecycleState;
  readonly title: string;
  readonly explanation: string;
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface DashboardSecuritySnapshot {
  readonly summary: {
    readonly total: number;
    readonly active: number;
    readonly criticalHighActive: number;
    readonly verified: number;
    readonly published: number;
    readonly resolved: number;
    readonly dismissed: number;
    readonly stale: number;
    readonly superseded: number;
    readonly repositoriesWithFindings: number;
  };
  readonly items: readonly DashboardSecurityFindingRow[];
}

function count(value: string | number | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export class DashboardSecurityStore {
  public constructor(private readonly pool: PgPool) {}

  public async snapshot(input: DashboardSecurityFilters): Promise<DashboardSecuritySnapshot> {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1000) throw new Error("DASHBOARD_SECURITY_LIMIT_INVALID");
    const params = [input.organizationId, input.repositoryIds, input.severities, input.lifecycle, input.limit] as const;
    return this.#readTransaction(async (client) => {
      const summary = await client.query<{
        total: string; active: string; critical_high_active: string; verified: string; published: string;
        resolved: string; dismissed: string; stale: string; superseded: string; repositories: string;
      }>(
        `SELECT count(*)::text AS total,
                count(*) FILTER (WHERE f.state IN ('verified','published','stale'))::text AS active,
                count(*) FILTER (WHERE f.state IN ('verified','published','stale') AND f.severity IN ('critical','high'))::text AS critical_high_active,
                count(*) FILTER (WHERE f.state='verified')::text AS verified,
                count(*) FILTER (WHERE f.state='published')::text AS published,
                count(*) FILTER (WHERE f.state='resolved')::text AS resolved,
                count(*) FILTER (WHERE f.state='dismissed')::text AS dismissed,
                count(*) FILTER (WHERE f.state='stale')::text AS stale,
                count(*) FILTER (WHERE f.state='superseded')::text AS superseded,
                count(DISTINCT f.repository_id)::text AS repositories
           FROM review_findings AS f
          WHERE f.organization_id=$1 AND f.category='security'
            AND (cardinality($2::uuid[])=0 OR f.repository_id=ANY($2::uuid[]))
            AND (cardinality($3::text[])=0 OR f.severity=ANY($3::text[]))
            AND (cardinality($4::text[])=0 OR f.state=ANY($4::text[]))`,
        params.slice(0, 4),
      );
      const rows = await client.query<{
        id: string; repository_id: string; repository_name: string; review_run_id: string;
        pull_request_id: string | null; pull_request_number: number | null; pull_request_title: string | null;
        author: string | null; pull_request_state: "open" | "closed" | "merged" | null;
        severity: FindingSeverity; state: FindingLifecycleState; title: string; explanation: string; path: string;
        start_line: number; end_line: number; created_at: Date; updated_at: Date;
      }>(
        `SELECT f.id, f.repository_id, r.name AS repository_name, f.review_run_id,
                req.pull_request_id, pr.number AS pull_request_number, pr.title AS pull_request_title,
                COALESCE(NULLIF(pr.author #>> '{provider,handle}',''), NULLIF(pr.author #>> '{displayName}',''), NULLIF(pr.author #>> '{provider,externalId}','')) AS author,
                pr.state AS pull_request_state,
                f.severity, f.state, f.title, f.explanation, f.path, f.start_line, f.end_line,
                f.created_at, f.updated_at
           FROM review_findings AS f
           JOIN repositories AS r ON r.organization_id=f.organization_id AND r.id=f.repository_id
           JOIN review_runs AS run ON run.organization_id=f.organization_id AND run.id=f.review_run_id
           JOIN review_requests AS req ON req.organization_id=run.organization_id AND req.id=run.request_id
           LEFT JOIN pull_requests AS pr ON pr.organization_id=req.organization_id AND pr.id=req.pull_request_id
          WHERE f.organization_id=$1 AND f.category='security'
            AND (cardinality($2::uuid[])=0 OR f.repository_id=ANY($2::uuid[]))
            AND (cardinality($3::text[])=0 OR f.severity=ANY($3::text[]))
            AND (cardinality($4::text[])=0 OR f.state=ANY($4::text[]))
          ORDER BY f.created_at DESC, f.id
          LIMIT $5`,
        params,
      );
      const first = summary.rows[0];
      return {
        summary: {
          total: count(first?.total), active: count(first?.active), criticalHighActive: count(first?.critical_high_active),
          verified: count(first?.verified), published: count(first?.published), resolved: count(first?.resolved),
          dismissed: count(first?.dismissed), stale: count(first?.stale), superseded: count(first?.superseded),
          repositoriesWithFindings: count(first?.repositories),
        },
        items: rows.rows.map((row) => ({
          id: row.id, repositoryId: row.repository_id, repositoryName: row.repository_name, reviewRunId: row.review_run_id,
          pullRequestId: row.pull_request_id, pullRequestNumber: row.pull_request_number, pullRequestTitle: row.pull_request_title,
          author: row.author, pullRequestState: row.pull_request_state, severity: row.severity, lifecycle: row.state,
          title: row.title, explanation: row.explanation, path: row.path, startLine: row.start_line, endLine: row.end_line,
          createdAt: row.created_at, updatedAt: row.updated_at,
        })),
      };
    });
  }

  async #readTransaction<T>(work: (client: PgClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const value = await work(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* preserve original */ }
      throw error;
    } finally { client.release(); }
  }
}
