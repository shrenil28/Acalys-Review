import type { PgClient, PgPool } from "../webhook/postgres-inbox.js";

export interface ReviewDispatchClaim {
  readonly reviewRunId: string;
  readonly organizationId: string;
  readonly revisionId: string;
  readonly pullRequestId: string;
  readonly attempts: number;
  readonly claimGeneration: number;
}

export class StaleReviewDispatchClaim extends Error {
  public constructor() { super("Review dispatch claim is stale"); this.name = "StaleReviewDispatchClaim"; }
}

export class ReviewDispatchStore {
  public constructor(private readonly pool: PgPool) {}

  public async enqueue(input: { readonly reviewRunId: string; readonly organizationId: string; readonly revisionId: string; readonly pullRequestId: string; readonly now: Date }): Promise<void> {
    await this.pool.query(
      `INSERT INTO review_dispatch_jobs
         (review_run_id, organization_id, revision_id, pull_request_id, available_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$5,$5)
       ON CONFLICT (review_run_id) DO NOTHING`,
      [input.reviewRunId, input.organizationId, input.revisionId, input.pullRequestId, input.now],
    );
  }

  public async claim(limit: number, leaseMillis: number, now: Date): Promise<readonly ReviewDispatchClaim[]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const selected = await client.query<{ review_run_id:string; organization_id:string; revision_id:string; pull_request_id:string; attempts:number; claim_generation:number }>(
        `SELECT review_run_id, organization_id, revision_id, pull_request_id, attempts, claim_generation
           FROM review_dispatch_jobs
          WHERE available_at <= $1 AND dead_lettered_at IS NULL AND (lease_expires_at IS NULL OR lease_expires_at <= $1)
          ORDER BY available_at, review_run_id
          FOR UPDATE SKIP LOCKED LIMIT $2`, [now, limit]);
      const claims: ReviewDispatchClaim[] = [];
      for (const row of selected.rows) {
        const generation = row.claim_generation + 1;
        await client.query(
          `UPDATE review_dispatch_jobs
              SET claim_generation=$2, lease_expires_at=$3, attempts=attempts+1, updated_at=$4
            WHERE review_run_id=$1`,
          [row.review_run_id, generation, new Date(now.getTime()+leaseMillis), now]);
        claims.push({ reviewRunId:row.review_run_id, organizationId:row.organization_id, revisionId:row.revision_id, pullRequestId:row.pull_request_id, attempts:row.attempts+1, claimGeneration:generation });
      }
      await client.query("COMMIT");
      return claims;
    } catch (error) { await client.query("ROLLBACK").catch(()=>undefined); throw error; }
    finally { client.release(); }
  }

  public async complete(reviewRunId:string, generation:number): Promise<void> {
    const r=await this.pool.query(`DELETE FROM review_dispatch_jobs WHERE review_run_id=$1 AND claim_generation=$2`,[reviewRunId,generation]);
    if (r.rowCount!==1) throw new StaleReviewDispatchClaim();
  }

  public async defer(reviewRunId:string, generation:number, availableAt:Date, now:Date): Promise<void> {
    const r=await this.pool.query(
      `UPDATE review_dispatch_jobs SET available_at=$3, lease_expires_at=NULL,
          attempts=GREATEST(attempts-1,0), claim_generation=claim_generation+1, updated_at=$4
        WHERE review_run_id=$1 AND claim_generation=$2`,[reviewRunId,generation,availableAt,now]);
    if (r.rowCount!==1) throw new StaleReviewDispatchClaim();
  }

  public async release(reviewRunId:string, generation:number, availableAt:Date, errorCode:string, now:Date): Promise<void> {
    const client=await this.pool.connect();
    try{
      await client.query("BEGIN");
      const current=await client.query<{attempts:number;max_attempts:number}>(
        `SELECT attempts,max_attempts FROM review_dispatch_jobs WHERE review_run_id=$1 AND claim_generation=$2 FOR UPDATE`,[reviewRunId,generation]);
      const row=current.rows[0]; if(row===undefined)throw new StaleReviewDispatchClaim();
      if(row.attempts>=row.max_attempts){ await this.deadLetterWithClient(client,reviewRunId,generation,errorCode,now); }
      else {
        await client.query(`UPDATE review_dispatch_jobs SET available_at=$3, lease_expires_at=NULL, claim_generation=claim_generation+1, last_error_code=$4, updated_at=$5 WHERE review_run_id=$1 AND claim_generation=$2`,[reviewRunId,generation,availableAt,errorCode,now]);
      }
      await client.query("COMMIT");
    }catch(error){await client.query("ROLLBACK").catch(()=>undefined);throw error;}finally{client.release();}
  }

  public async deadLetter(reviewRunId:string,generation:number,errorCode:string,now:Date):Promise<void>{
    const client=await this.pool.connect();
    try{await client.query("BEGIN");await this.deadLetterWithClient(client,reviewRunId,generation,errorCode,now);await client.query("COMMIT");}
    catch(error){await client.query("ROLLBACK").catch(()=>undefined);throw error;}finally{client.release();}
  }

  private async deadLetterWithClient(client:PgClient,reviewRunId:string,generation:number,errorCode:string,now:Date):Promise<void>{
    const claimed=await client.query(
      `UPDATE review_dispatch_jobs SET lease_expires_at=NULL,claim_generation=claim_generation+1,last_error_code=$3,dead_lettered_at=$4,updated_at=$4 WHERE review_run_id=$1 AND claim_generation=$2 AND dead_lettered_at IS NULL`,
      [reviewRunId,generation,errorCode,now]);
    if(claimed.rowCount!==1)throw new StaleReviewDispatchClaim();
    const run=await client.query<{state:string}>(`SELECT state FROM review_runs WHERE id=$1 FOR UPDATE`,[reviewRunId]);
    const state=run.rows[0]?.state;
    if(state!==undefined && ["queued","preparing","analyzing","reviewing","verifying","reconciling"].includes(state)){
      const seq=await client.query<{next_seq:number}>(`SELECT COALESCE(MAX(seq),0)+1 AS next_seq FROM review_run_transitions WHERE run_id=$1`,[reviewRunId]);
      await client.query(`UPDATE review_runs SET state='failed',failure_code=$2,failure_retryability='non_retryable',completed_at=$3 WHERE id=$1 AND state=$4`,[reviewRunId,errorCode,now,state]);
      await client.query(`INSERT INTO review_run_transitions(run_id,seq,from_state,to_state,at) VALUES($1,$2,$3,'failed',$4)`,[reviewRunId,seq.rows[0]?.next_seq??1,state,now]);
    }
  }

}
