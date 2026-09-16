import type { PgClient, PgPool } from "./webhook/postgres-inbox.js";

export interface DashboardAnalyticsFilters {
  readonly organizationId: string;
  readonly from: Date;
  readonly to: Date;
  readonly repositoryIds: readonly string[];
  readonly usernames: readonly string[];
  readonly teams: readonly string[];
}

export interface DashboardAnalyticsSnapshot {
  readonly bucketSeconds: number;
  readonly summary: {
    readonly reviews: number;
    readonly completed: number;
    readonly failed: number;
    readonly cancelled: number;
    readonly findings: number;
    readonly resolvedFindings: number;
    readonly repositories: number;
    readonly authors: number;
    readonly averageDurationSeconds: number | null;
  };
  readonly trends: readonly {
    readonly start: Date;
    readonly reviews: number;
    readonly completed: number;
    readonly failed: number;
    readonly findings: number;
  }[];
  readonly severities: readonly {
    readonly severity: string;
    readonly count: number;
  }[];
  readonly categories: readonly {
    readonly category: string;
    readonly count: number;
  }[];
  readonly checks: {
    readonly total: number;
    readonly passed: number;
    readonly failed: number;
    readonly inconclusive: number;
    readonly skipped: number;
  };
  readonly knowledge: {
    readonly total: number;
    readonly newInRange: number;
    readonly byRepository: readonly {
      readonly repositoryId: string | null;
      readonly repositoryName: string | null;
      readonly count: number;
    }[];
  };
  readonly repositories: readonly {
    readonly repositoryId: string;
    readonly name: string;
    readonly reviews: number;
    readonly findings: number;
    readonly averageDurationSeconds: number | null;
    readonly lastReviewAt: Date | null;
  }[];
  readonly authors: readonly {
    readonly username: string;
    readonly team: string | null;
    readonly reviews: number;
    readonly findings: number;
  }[];
  readonly dimensions: {
    readonly usernames: readonly string[];
    readonly teams: readonly string[];
  };
}

const MAX_RANGE_MS = 5 * 366 * 24 * 60 * 60_000;

// Keep every list-shaped projection at or below the public dashboard contract.
// These are browse/filter projections, not source-of-truth counts; the summary
// queries above them still count the complete filtered population. Bounding at
// SQL time prevents a large organization from turning valid data into an API
// schema failure or an unbounded in-memory response.
const MAX_SEVERITIES = 32;
const MAX_CATEGORIES = 200;
const MAX_KNOWLEDGE_REPOSITORIES = 500;
const MAX_REPOSITORIES = 500;
const MAX_AUTHORS = 1_000;
const MAX_DIMENSION_USERNAMES = 2_000;
const MAX_DIMENSION_TEAMS = 500;
const authorName = `COALESCE(NULLIF(req.target #>> '{author,provider,handle}', ''), NULLIF(req.target #>> '{author,displayName}', ''), NULLIF(req.target #>> '{author,provider,externalId}', ''), 'unknown')`;
const authorJoin = `LEFT JOIN users AS au
    ON au.provider = req.target #>> '{author,provider,provider}'
   AND au.provider_user_id = req.target #>> '{author,provider,externalId}'
  LEFT JOIN memberships AS am ON am.organization_id = run.organization_id AND am.user_id = au.id`;
const filter = `(cardinality($4::uuid[]) = 0 OR run.repository_id = ANY($4::uuid[]))
    AND (cardinality($5::text[]) = 0 OR ${authorName} = ANY($5::text[]))
    AND (cardinality($6::text[]) = 0 OR am.analytics_team = ANY($6::text[]))`;

function number(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}
function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function chooseBucketSeconds(spanMs: number): number {
  const hour = 3600;
  const options = [hour, 6 * hour, 24 * hour, 7 * 24 * hour, 30 * 24 * hour];
  return (
    options.find((seconds) => spanMs / (seconds * 1000) <= 120) ??
    options[options.length - 1]!
  );
}

export class DashboardAnalyticsStore {
  public constructor(private readonly pool: PgPool) {}

  public async snapshot(
    input: DashboardAnalyticsFilters,
  ): Promise<DashboardAnalyticsSnapshot> {
    const span = input.to.getTime() - input.from.getTime();
    if (!Number.isFinite(span) || span <= 0 || span > MAX_RANGE_MS)
      throw new Error("DASHBOARD_ANALYTICS_RANGE_INVALID");
    const bucketSeconds = chooseBucketSeconds(span);
    const params = [
      input.organizationId,
      input.from,
      input.to,
      input.repositoryIds,
      input.usernames,
      input.teams,
      bucketSeconds,
    ] as const;
    return this.readTransaction(async (client) => {
      const reviewSummary = await client.query<{
        reviews: string;
        completed: string;
        failed: string;
        cancelled: string;
        repositories: string;
        authors: string;
        average_duration_seconds: string | null;
      }>(
        `SELECT count(*)::text AS reviews,
                count(*) FILTER (WHERE run.state = 'completed')::text AS completed,
                count(*) FILTER (WHERE run.state = 'failed')::text AS failed,
                count(*) FILTER (WHERE run.state = 'cancelled')::text AS cancelled,
                count(DISTINCT run.repository_id)::text AS repositories,
                count(DISTINCT ${authorName})::text AS authors,
                avg(EXTRACT(EPOCH FROM (run.completed_at - run.started_at))) FILTER (WHERE run.completed_at IS NOT NULL AND run.started_at IS NOT NULL) AS average_duration_seconds
           FROM review_runs AS run
           JOIN review_requests AS req ON req.id = run.request_id AND req.organization_id = run.organization_id
           ${authorJoin}
          WHERE run.organization_id = $1 AND run.created_at >= $2 AND run.created_at < $3 AND ${filter}`,
        params.slice(0, 6),
      );
      const findings = await client.query<{
        findings: string;
        resolved: string;
      }>(
        `SELECT count(*)::text AS findings, count(*) FILTER (WHERE f.state = 'resolved')::text AS resolved
           FROM review_findings AS f
           JOIN review_runs AS run ON run.id = f.review_run_id AND run.organization_id = f.organization_id
           JOIN review_requests AS req ON req.id = run.request_id AND req.organization_id = run.organization_id
           ${authorJoin}
          WHERE f.organization_id = $1 AND f.created_at >= $2 AND f.created_at < $3 AND ${filter}`,
        params.slice(0, 6),
      );
      const reviewBuckets = await client.query<{
        bucket: Date;
        reviews: string;
        completed: string;
        failed: string;
      }>(
        `SELECT to_timestamp(floor(EXTRACT(EPOCH FROM run.created_at) / $7) * $7) AS bucket,
                count(*)::text AS reviews,
                count(*) FILTER (WHERE run.state = 'completed')::text AS completed,
                count(*) FILTER (WHERE run.state = 'failed')::text AS failed
           FROM review_runs AS run
           JOIN review_requests AS req ON req.id = run.request_id AND req.organization_id = run.organization_id
           ${authorJoin}
          WHERE run.organization_id = $1 AND run.created_at >= $2 AND run.created_at < $3 AND ${filter}
          GROUP BY bucket ORDER BY bucket`,
        params,
      );
      const findingBuckets = await client.query<{
        bucket: Date;
        findings: string;
      }>(
        `SELECT to_timestamp(floor(EXTRACT(EPOCH FROM f.created_at) / $7) * $7) AS bucket, count(*)::text AS findings
           FROM review_findings AS f
           JOIN review_runs AS run ON run.id = f.review_run_id AND run.organization_id = f.organization_id
           JOIN review_requests AS req ON req.id = run.request_id AND req.organization_id = run.organization_id
           ${authorJoin}
          WHERE f.organization_id = $1 AND f.created_at >= $2 AND f.created_at < $3 AND ${filter}
          GROUP BY bucket ORDER BY bucket`,
        params,
      );
      const severity = await client.query<{ severity: string; count: string }>(
        `SELECT f.severity, count(*)::text AS count FROM review_findings AS f
           JOIN review_runs AS run ON run.id=f.review_run_id AND run.organization_id=f.organization_id
           JOIN review_requests AS req ON req.id=run.request_id AND req.organization_id=run.organization_id ${authorJoin}
          WHERE f.organization_id=$1 AND f.created_at >= $2 AND f.created_at < $3 AND ${filter}
          GROUP BY f.severity ORDER BY count(*) DESC, f.severity
          LIMIT ${MAX_SEVERITIES}`,
        params.slice(0, 6),
      );
      const categories = await client.query<{
        category: string;
        count: string;
      }>(
        `SELECT f.category, count(*)::text AS count FROM review_findings AS f
           JOIN review_runs AS run ON run.id=f.review_run_id AND run.organization_id=f.organization_id
           JOIN review_requests AS req ON req.id=run.request_id AND req.organization_id=run.organization_id ${authorJoin}
          WHERE f.organization_id=$1 AND f.created_at >= $2 AND f.created_at < $3 AND ${filter}
          GROUP BY f.category ORDER BY count(*) DESC, f.category
          LIMIT ${MAX_CATEGORIES}`,
        params.slice(0, 6),
      );
      const checks = await client.query<{
        total: string;
        passed: string;
        failed: string;
        inconclusive: string;
        skipped: string;
      }>(
        `SELECT count(*)::text AS total,
                count(*) FILTER (WHERE c.status='passed')::text AS passed,
                count(*) FILTER (WHERE c.status='failed')::text AS failed,
                count(*) FILTER (WHERE c.status='inconclusive')::text AS inconclusive,
                count(*) FILTER (WHERE c.status='skipped')::text AS skipped
           FROM premerge_check_results AS c
           JOIN review_runs AS run ON run.id=c.review_run_id AND run.organization_id=c.organization_id
           JOIN review_requests AS req ON req.id=run.request_id AND req.organization_id=run.organization_id ${authorJoin}
          WHERE c.organization_id=$1 AND COALESCE(c.evaluated_at,c.created_at) >= $2 AND COALESCE(c.evaluated_at,c.created_at) < $3 AND ${filter}`,
        params.slice(0, 6),
      );
      const knowledge = await client.query<{
        total: string;
        new_in_range: string;
      }>(
        `SELECT count(*)::text AS total,
                count(*) FILTER (WHERE COALESCE(recorded_at,created_at) >= $2 AND COALESCE(recorded_at,created_at) < $3)::text AS new_in_range
           FROM knowledge_items
          WHERE organization_id=$1 AND active=TRUE
            AND (cardinality($4::uuid[]) = 0 OR repository_id = ANY($4::uuid[]) OR repository_id IS NULL)`,
        params.slice(0, 4),
      );
      const knowledgeByRepository = await client.query<{
        repository_id: string | null;
        repository_name: string | null;
        count: string;
      }>(
        `SELECT k.repository_id, r.name AS repository_name, count(*)::text AS count
           FROM knowledge_items AS k LEFT JOIN repositories AS r ON r.id=k.repository_id AND r.organization_id=k.organization_id
          WHERE k.organization_id=$1 AND k.active=TRUE AND COALESCE(k.recorded_at,k.created_at) >= $2 AND COALESCE(k.recorded_at,k.created_at) < $3
            AND (cardinality($4::uuid[]) = 0 OR k.repository_id = ANY($4::uuid[]) OR k.repository_id IS NULL)
          GROUP BY k.repository_id,r.name
          ORDER BY count(*) DESC,r.name NULLS FIRST,k.repository_id NULLS FIRST
          LIMIT ${MAX_KNOWLEDGE_REPOSITORIES}`,
        params.slice(0, 4),
      );
      const repositories = await client.query<{
        repository_id: string;
        name: string;
        reviews: string;
        findings: string;
        average_duration_seconds: string | null;
        last_review_at: Date | null;
      }>(
        `WITH reviews AS (
           SELECT run.repository_id, count(*) AS reviews,
                  avg(EXTRACT(EPOCH FROM (run.completed_at-run.started_at))) FILTER (WHERE run.completed_at IS NOT NULL AND run.started_at IS NOT NULL) AS average_duration_seconds,
                  max(run.created_at) AS last_review_at
             FROM review_runs AS run JOIN review_requests AS req ON req.id=run.request_id AND req.organization_id=run.organization_id ${authorJoin}
            WHERE run.organization_id=$1 AND run.created_at >= $2 AND run.created_at < $3 AND ${filter}
            GROUP BY run.repository_id
         ), finding_counts AS (
           SELECT run.repository_id, count(*) AS findings
             FROM review_findings AS f JOIN review_runs AS run ON run.id=f.review_run_id AND run.organization_id=f.organization_id
             JOIN review_requests AS req ON req.id=run.request_id AND req.organization_id=run.organization_id ${authorJoin}
            WHERE f.organization_id=$1 AND f.created_at >= $2 AND f.created_at < $3 AND ${filter}
            GROUP BY run.repository_id
         )
         SELECT r.id AS repository_id,r.name,COALESCE(v.reviews,0)::text AS reviews,COALESCE(f.findings,0)::text AS findings,
                v.average_duration_seconds,v.last_review_at
           FROM repositories AS r LEFT JOIN reviews AS v ON v.repository_id=r.id LEFT JOIN finding_counts AS f ON f.repository_id=r.id
          WHERE r.organization_id=$1 AND (cardinality($4::uuid[]) = 0 OR r.id=ANY($4::uuid[])) AND (v.repository_id IS NOT NULL OR f.repository_id IS NOT NULL)
          ORDER BY COALESCE(v.reviews,0) DESC,r.name,r.id
          LIMIT ${MAX_REPOSITORIES}`,
        params.slice(0, 6),
      );
      const authors = await client.query<{
        username: string;
        team: string | null;
        reviews: string;
        findings: string;
      }>(
        `WITH review_authors AS (
           SELECT ${authorName} AS username, am.analytics_team AS team, count(*) AS reviews
             FROM review_runs AS run JOIN review_requests AS req ON req.id=run.request_id AND req.organization_id=run.organization_id ${authorJoin}
            WHERE run.organization_id=$1 AND run.created_at >= $2 AND run.created_at < $3 AND ${filter}
            GROUP BY username,am.analytics_team
         ), finding_authors AS (
           SELECT ${authorName} AS username, am.analytics_team AS team, count(*) AS findings
             FROM review_findings AS f JOIN review_runs AS run ON run.id=f.review_run_id AND run.organization_id=f.organization_id
             JOIN review_requests AS req ON req.id=run.request_id AND req.organization_id=run.organization_id ${authorJoin}
            WHERE f.organization_id=$1 AND f.created_at >= $2 AND f.created_at < $3 AND ${filter}
            GROUP BY username,am.analytics_team
         )
         SELECT COALESCE(r.username,f.username) AS username,COALESCE(r.team,f.team) AS team,
                COALESCE(r.reviews,0)::text AS reviews,COALESCE(f.findings,0)::text AS findings
           FROM review_authors r FULL JOIN finding_authors f ON f.username=r.username AND f.team IS NOT DISTINCT FROM r.team
          ORDER BY COALESCE(r.reviews,0) DESC, username, team NULLS FIRST
          LIMIT ${MAX_AUTHORS}`,
        params.slice(0, 6),
      );
      const dimensionUsernames = await client.query<{ username: string }>(
        `SELECT DISTINCT ${authorName} AS username
           FROM review_runs AS run
           JOIN review_requests AS req ON req.id=run.request_id AND req.organization_id=run.organization_id
           ${authorJoin}
          WHERE run.organization_id=$1 AND run.created_at >= $2 AND run.created_at < $3
            AND (cardinality($4::uuid[]) = 0 OR run.repository_id = ANY($4::uuid[]))
          ORDER BY username
          LIMIT ${MAX_DIMENSION_USERNAMES}`,
        params.slice(0, 4),
      );
      const dimensionTeams = await client.query<{ team: string }>(
        `SELECT DISTINCT am.analytics_team AS team
           FROM review_runs AS run
           JOIN review_requests AS req ON req.id=run.request_id AND req.organization_id=run.organization_id
           ${authorJoin}
          WHERE run.organization_id=$1 AND run.created_at >= $2 AND run.created_at < $3
            AND (cardinality($4::uuid[]) = 0 OR run.repository_id = ANY($4::uuid[]))
            AND am.analytics_team IS NOT NULL
          ORDER BY team
          LIMIT ${MAX_DIMENSION_TEAMS}`,
        params.slice(0, 4),
      );

      const trend = new Map<
        number,
        {
          start: Date;
          reviews: number;
          completed: number;
          failed: number;
          findings: number;
        }
      >();
      const bucketMs = bucketSeconds * 1000;
      for (
        let t = Math.floor(input.from.getTime() / bucketMs) * bucketMs;
        t < input.to.getTime();
        t += bucketMs
      )
        trend.set(t, {
          start: new Date(t),
          reviews: 0,
          completed: 0,
          failed: 0,
          findings: 0,
        });
      for (const row of reviewBuckets.rows) {
        const key = row.bucket.getTime();
        const item = trend.get(key) ?? {
          start: row.bucket,
          reviews: 0,
          completed: 0,
          failed: 0,
          findings: 0,
        };
        item.reviews = number(row.reviews);
        item.completed = number(row.completed);
        item.failed = number(row.failed);
        trend.set(key, item);
      }
      for (const row of findingBuckets.rows) {
        const key = row.bucket.getTime();
        const item = trend.get(key) ?? {
          start: row.bucket,
          reviews: 0,
          completed: 0,
          failed: 0,
          findings: 0,
        };
        item.findings = number(row.findings);
        trend.set(key, item);
      }
      const s = reviewSummary.rows[0];
      const f = findings.rows[0];
      const c = checks.rows[0];
      const k = knowledge.rows[0];
      return {
        bucketSeconds,
        summary: {
          reviews: number(s?.reviews),
          completed: number(s?.completed),
          failed: number(s?.failed),
          cancelled: number(s?.cancelled),
          findings: number(f?.findings),
          resolvedFindings: number(f?.resolved),
          repositories: number(s?.repositories),
          authors: number(s?.authors),
          averageDurationSeconds: nullableNumber(s?.average_duration_seconds),
        },
        trends: [...trend.values()].sort(
          (a, b) => a.start.getTime() - b.start.getTime(),
        ),
        severities: severity.rows.map((row) => ({
          severity: row.severity,
          count: number(row.count),
        })),
        categories: categories.rows.map((row) => ({
          category: row.category,
          count: number(row.count),
        })),
        checks: {
          total: number(c?.total),
          passed: number(c?.passed),
          failed: number(c?.failed),
          inconclusive: number(c?.inconclusive),
          skipped: number(c?.skipped),
        },
        knowledge: {
          total: number(k?.total),
          newInRange: number(k?.new_in_range),
          byRepository: knowledgeByRepository.rows.map((row) => ({
            repositoryId: row.repository_id,
            repositoryName: row.repository_name,
            count: number(row.count),
          })),
        },
        repositories: repositories.rows.map((row) => ({
          repositoryId: row.repository_id,
          name: row.name,
          reviews: number(row.reviews),
          findings: number(row.findings),
          averageDurationSeconds: nullableNumber(row.average_duration_seconds),
          lastReviewAt: row.last_review_at,
        })),
        authors: authors.rows.map((row) => ({
          username: row.username,
          team: row.team,
          reviews: number(row.reviews),
          findings: number(row.findings),
        })),
        dimensions: {
          usernames: dimensionUsernames.rows.map((row) => row.username),
          teams: dimensionTeams.rows.map((row) => row.team),
        },
      };
    });
  }

  private async readTransaction<T>(
    work: (client: PgClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const value = await work(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* original error wins */
      }
      throw error;
    } finally {
      client.release();
    }
  }
}
