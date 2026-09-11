import type { PgClient, PgPool } from "./webhook/postgres-inbox.js";

export interface DashboardRepositoryMetricRow {
  readonly repositoryId: string;
  readonly openPullRequests: number;
  readonly reviewsLast30Days: number;
  readonly publishedCommentsLast30Days: number;
  readonly lastReviewAt: Date | null;
}
export interface DashboardRepositoryOverviewRow {
  readonly repositoryId: string;
  readonly metrics: DashboardRepositoryMetricRow;
  readonly trend: readonly { readonly day: string; readonly reviews: number }[];
  readonly recentActivity: readonly {
    readonly reviewRunId: string; readonly pullRequestNumber: number | null; readonly pullRequestTitle: string | null;
    readonly state: "queued"|"preparing"|"analyzing"|"reviewing"|"verifying"|"reconciling"|"publishing"|"completed"|"failed"|"cancelled"|"superseded";
    readonly trigger: string; readonly createdAt: Date; readonly completedAt: Date | null; readonly publishedComments: number;
  }[];
}
function number(value: string | number | null | undefined): number { const parsed=Number(value??0); return Number.isFinite(parsed)?parsed:0; }

const MAX_REPOSITORY_METRIC_ROWS = 10_000;

export class DashboardRepositoryStore {
  public constructor(private readonly pool: PgPool) {}

  public async listMetrics(organizationId: string): Promise<readonly DashboardRepositoryMetricRow[]> {
    const result = await this.pool.query<{
      repository_id:string; open_pull_requests:string; reviews_30d:string; comments_30d:string; last_review_at:Date|null;
    }>(this.#metricsSql(), [organizationId]);
    return result.rows.map((row)=>({
      repositoryId:row.repository_id, openPullRequests:number(row.open_pull_requests), reviewsLast30Days:number(row.reviews_30d),
      publishedCommentsLast30Days:number(row.comments_30d), lastReviewAt:row.last_review_at,
    }));
  }

  public async overview(organizationId:string, repositoryId:string):Promise<DashboardRepositoryOverviewRow|undefined>{
    return this.#readTransaction(async(client)=>{
      const exists=await client.query<{id:string}>(`SELECT id FROM repositories WHERE organization_id=$1 AND id=$2`,[organizationId,repositoryId]);
      if(exists.rows[0]===undefined)return undefined;
      const metrics=await client.query<{repository_id:string;open_pull_requests:string;reviews_30d:string;comments_30d:string;last_review_at:Date|null}>(this.#metricsSql(`AND r.id=$2`),[organizationId,repositoryId]);
      const metric=metrics.rows[0];
      if(metric===undefined)return undefined;
      const trend=await client.query<{day:string;reviews:string}>(
        `WITH clock AS (SELECT clock_timestamp() AS now), days AS (
           SELECT generate_series(date_trunc('day',(SELECT now FROM clock))-interval '29 days',date_trunc('day',(SELECT now FROM clock)),interval '1 day') AS day
         ), reviews AS (
           SELECT date_trunc('day',run.created_at) AS day,count(*)::text AS reviews
             FROM review_runs AS run,clock
            WHERE run.organization_id=$1 AND run.repository_id=$2 AND run.created_at >= date_trunc('day',clock.now)-interval '29 days'
            GROUP BY date_trunc('day',run.created_at)
         ) SELECT to_char(days.day,'YYYY-MM-DD') AS day,COALESCE(reviews.reviews,'0') AS reviews FROM days LEFT JOIN reviews USING(day) ORDER BY days.day`,
        [organizationId,repositoryId],
      );
      const activity=await client.query<{
        review_run_id:string;pull_request_number:number|null;pull_request_title:string|null;state:DashboardRepositoryOverviewRow["recentActivity"][number]["state"];
        trigger:string;created_at:Date;completed_at:Date|null;published_comments:string;
      }>(
        `SELECT run.id AS review_run_id,pr.number AS pull_request_number,pr.title AS pull_request_title,run.state,req.trigger,
                run.created_at,run.completed_at,
                count(pub.id) FILTER (WHERE pub.kind='inline_comment' AND pub.state='published' AND pub.confirmed_at IS NOT NULL)::text AS published_comments
           FROM review_runs AS run
           JOIN review_requests AS req ON req.organization_id=run.organization_id AND req.id=run.request_id
           LEFT JOIN pull_requests AS pr ON pr.organization_id=req.organization_id AND pr.id=req.pull_request_id
           LEFT JOIN publication_intents AS pub ON pub.organization_id=run.organization_id AND pub.review_run_id=run.id
          WHERE run.organization_id=$1 AND run.repository_id=$2
          GROUP BY run.id,pr.number,pr.title,run.state,req.trigger,run.created_at,run.completed_at
          ORDER BY run.created_at DESC,run.id DESC LIMIT 50`,
        [organizationId,repositoryId],
      );
      return {
        repositoryId,
        metrics:{repositoryId,openPullRequests:number(metric.open_pull_requests),reviewsLast30Days:number(metric.reviews_30d),publishedCommentsLast30Days:number(metric.comments_30d),lastReviewAt:metric.last_review_at},
        trend:trend.rows.map((row)=>({day:row.day,reviews:number(row.reviews)})),
        recentActivity:activity.rows.map((row)=>({reviewRunId:row.review_run_id,pullRequestNumber:row.pull_request_number,pullRequestTitle:row.pull_request_title,state:row.state,trigger:row.trigger,createdAt:row.created_at,completedAt:row.completed_at,publishedComments:number(row.published_comments)})),
      };
    });
  }

  #metricsSql(extra=""):string{return `WITH clock AS (SELECT clock_timestamp() AS now),
    open_prs AS (SELECT repository_id,count(*)::text AS count FROM pull_requests WHERE organization_id=$1 AND state='open' GROUP BY repository_id),
    reviews AS (SELECT repository_id,count(*)::text AS count FROM review_runs,clock WHERE organization_id=$1 AND created_at >= clock.now-interval '30 days' GROUP BY repository_id),
    comments AS (
      SELECT run.repository_id,count(pub.id)::text AS count
        FROM publication_intents AS pub JOIN review_runs AS run ON run.organization_id=pub.organization_id AND run.id=pub.review_run_id,clock
       WHERE pub.organization_id=$1 AND pub.kind='inline_comment' AND pub.state='published' AND pub.confirmed_at IS NOT NULL AND pub.confirmed_at >= clock.now-interval '30 days'
       GROUP BY run.repository_id
    ), last_reviews AS (SELECT repository_id,max(created_at) AS last_review_at FROM review_runs WHERE organization_id=$1 GROUP BY repository_id)
    SELECT r.id AS repository_id,COALESCE(open_prs.count,'0') AS open_pull_requests,COALESCE(reviews.count,'0') AS reviews_30d,
           COALESCE(comments.count,'0') AS comments_30d,last_reviews.last_review_at
      FROM repositories AS r LEFT JOIN open_prs ON open_prs.repository_id=r.id LEFT JOIN reviews ON reviews.repository_id=r.id
      LEFT JOIN comments ON comments.repository_id=r.id LEFT JOIN last_reviews ON last_reviews.repository_id=r.id
     WHERE r.organization_id=$1 ${extra} ORDER BY r.id LIMIT ${MAX_REPOSITORY_METRIC_ROWS}`}

  async #readTransaction<T>(work:(client:PgClient)=>Promise<T>):Promise<T>{const client=await this.pool.connect();try{await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");const value=await work(client);await client.query("COMMIT");return value;}catch(error){try{await client.query("ROLLBACK");}catch{/* original */}throw error;}finally{client.release();}}
}
